import { countLines, fmtInt, isRecord, toolLabel } from './format.ts'
import { applyRuleToText, compileRule, summaryText } from './regex.ts'
import type { DeletedItem, Role, RuleOutcome, StubbedItem, TranscriptResult, TrimReport, TrimRequest } from './types.ts'

/*
 * Transcript layout this module relies on (observed, not a public contract — the
 * docs say the entry format is internal and may change between releases):
 *
 *  - one JSON object per line;
 *  - message lines have `type` "user" | "assistant", a `uuid`, a `parentUuid`
 *    and `message: { role, content }`;
 *  - `content` is a string (plain prompt) or an array of blocks;
 *  - ONE assistant API message is split over several lines, one content block
 *    per line, all sharing `message.id`;
 *  - tool_use blocks live on assistant lines, tool_result blocks on user lines.
 *
 * Anything that does not parse, or does not look like a message, passes through
 * byte-for-byte. Regexes only ever see decoded strings, never raw JSON.
 */

type Json = Record<string, unknown>

interface Entry {
  raw: string
  obj: Json | null
  dirty: boolean
  removed: boolean
}

interface Loc {
  entry: number
  block: Json
}

const TRIMMED_PREFIX = '[Trimmed'

export function stubForResult(label: string, id: string, lines: number, chars: number, images: number): string {
  const extra = images > 0 ? ` (+${images} image${images === 1 ? '' : 's'})` : ''
  return `[Trimmed: ${fmtInt(lines)} lines / ${fmtInt(chars)} chars removed from ${label} (${id})${extra}]`
}

function messageOf(e: Entry): Json | null {
  const m = e.obj?.['message']
  return isRecord(m) ? m : null
}

function roleOf(e: Entry): Role | null {
  const t = e.obj?.['type']
  if (t === 'assistant' || t === 'user') return t
  return null
}

function contentArray(e: Entry): Json[] | null {
  const c = messageOf(e)?.['content']
  return Array.isArray(c) ? (c as Json[]) : null
}

/** Text of a tool_result block (string content, or the text parts of an array). */
function resultText(block: Json): { text: string; images: number } {
  const c = block['content']
  if (typeof c === 'string') return { text: c, images: 0 }
  if (Array.isArray(c)) {
    let images = 0
    const parts: string[] = []
    for (const p of c) {
      if (isRecord(p) && p['type'] === 'text' && typeof p['text'] === 'string') parts.push(p['text'])
      else if (isRecord(p) && p['type'] === 'image') images += 1
    }
    return { text: parts.join('\n'), images }
  }
  return { text: '', images: 0 }
}

function isThinking(b: Json): boolean {
  return b['type'] === 'thinking' || b['type'] === 'redacted_thinking'
}

/**
 * Apply a validated request to the lines of a transcript (or of its tail window).
 * Order: tool_targets, regex_rules, collapse of the trim_session turn itself,
 * thinking-block sanitisation from the earliest change on, parentUuid repair.
 * Never throws; returns { ok: false } and leaves the caller's data untouched.
 */
export function applyTrimToTranscript(
  inputLines: readonly string[],
  request: TrimRequest,
  ctx: {
    /** This turn's own trim_session call(s): must be in the transcript; collapsed into the session note. */
    trimCallIds: readonly string[]
    /**
     * EARLIER trim_session calls that only flagged things and whose flags are all resolved by now. Their
     * input (regexes, replacement text) and their "Flagged…" result are dead weight, so they are removed.
     * Best effort: one that is missing, or that sits before the first change this rewrite makes, is left alone.
     */
    settledCallIds?: readonly string[]
  },
): TranscriptResult {
  const entries: Entry[] = inputLines.map((raw) => {
    let obj: Json | null = null
    try {
      const v: unknown = JSON.parse(raw)
      if (isRecord(v)) obj = v
    } catch {
      /* opaque line: preserved verbatim */
    }
    return { raw, obj, dirty: false, removed: false }
  })

  let earliest = Infinity
  const touch = (i: number) => {
    const e = entries[i]
    if (e) e.dirty = true
    earliest = Math.min(earliest, i)
  }

  // ── index tool_use / tool_result blocks ────────────────────────────────────
  const uses = new Map<string, Loc[]>()
  const results = new Map<string, Loc[]>()
  const push = (m: Map<string, Loc[]>, id: string, loc: Loc) => {
    const l = m.get(id)
    if (l) l.push(loc)
    else m.set(id, [loc])
  }
  let liveStart = 0
  entries.forEach((e, i) => {
    const o = e.obj
    if (!o) return
    if ((o['type'] === 'system' && o['subtype'] === 'compact_boundary') || o['isCompactSummary'] === true) liveStart = i
    const content = contentArray(e)
    if (!content) return
    for (const b of content) {
      if (!isRecord(b)) continue
      if (b['type'] === 'tool_use' && typeof b['id'] === 'string') push(uses, b['id'], { entry: i, block: b })
      else if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') push(results, b['tool_use_id'], { entry: i, block: b })
    }
  })
  const pairedBefore = new Set<string>()
  for (const id of uses.keys()) if (results.has(id)) pairedBefore.add(id)

  const report: TrimReport = {
    stubbed: [],
    deleted: [],
    alreadyTrimmed: [],
    rules: [],
    collapsedTrimCalls: 0,
    settledCleared: [],
    thinkingBlocksStripped: 0,
    linesRemoved: 0,
    parentLinksRepaired: 0,
    savedChars: 0,
    changed: false,
  }
  const trimIds = new Set(ctx.trimCallIds)
  const deletedIds = new Set<string>()

  const dropBlock = (loc: Loc) => {
    const content = contentArray(entries[loc.entry] as Entry)
    if (!content) return
    const k = content.indexOf(loc.block)
    if (k >= 0) content.splice(k, 1)
    touch(loc.entry)
    if (content.length === 0) (entries[loc.entry] as Entry).removed = true
  }

  // ── 1. tool_targets ────────────────────────────────────────────────────────
  for (const t of request.targets) {
    if (trimIds.has(t.id)) return { ok: false, error: `${t.id} is the trim_session call itself and cannot be a target.` }
    const u = uses.get(t.id)?.[0]
    const rs = results.get(t.id) ?? []
    if (!u && rs.length === 0) return { ok: false, error: `tool_use_id ${t.id} was not found in the transcript.` }
    if (rs.length === 0) return { ok: false, error: `tool_use_id ${t.id} has no tool_result yet; nothing to trim.` }
    if (t.mode === 'delete' && !u) {
      return { ok: false, error: `Cannot delete ${t.id}: its tool_use is outside the trimmable window (deleting only the result would orphan it).` }
    }
    const name = typeof u?.block['name'] === 'string' ? u.block['name'] : 'tool'
    const input = isRecord(u?.block['input']) ? (u?.block['input'] as Record<string, unknown>) : undefined
    const label = toolLabel(name, input)

    if (t.mode === 'delete') {
      const chars = rs.reduce((n, r) => n + resultText(r.block).text.length, 0)
      for (const r of rs) dropBlock(r)
      if (u) dropBlock(u)
      deletedIds.add(t.id)
      report.deleted.push({ id: t.id, tool: name, label, chars } satisfies DeletedItem)
      report.savedChars += chars
      continue
    }

    for (const r of rs) {
      const { text, images } = resultText(r.block)
      if (text.startsWith(TRIMMED_PREFIX)) {
        report.alreadyTrimmed.push(t.id)
        continue
      }
      const lines = countLines(text)
      const replacement = t.mode === 'summary' ? summaryText(t.replacement ?? '') : stubForResult(label, t.id, lines, text.length, images)
      r.block['content'] = replacement
      touch(r.entry)
      report.savedChars += text.length - replacement.length
      report.stubbed.push({ id: t.id, tool: name, label, lines, chars: text.length, mode: t.mode } satisfies StubbedItem)
    }
  }

  // ── 2. regex_rules (decoded strings only) ──────────────────────────────────
  const compiled = request.rules.map((rule) => ({ rule, re: compileRule(rule.pattern, rule.flags) }))
  const outcomes: RuleOutcome[] = compiled.map(({ rule }) => ({ pattern: rule.pattern, matches: 0, blocks: 0, removedChars: 0, skippedBlocks: 0 }))

  const runRules = (text: string, role: Role, toolId: string | undefined): string => {
    let cur = text
    compiled.forEach(({ rule, re }, ri) => {
      if (rule.scopeRoles && !rule.scopeRoles.includes(role)) return
      if (rule.scopeToolIds && (!toolId || !rule.scopeToolIds.includes(toolId))) return
      if (cur.startsWith(TRIMMED_PREFIX) && toolId) return
      const res = applyRuleToText(cur, re, rule.mode, rule.replacement)
      const o = outcomes[ri] as RuleOutcome
      if (res.skipped) o.skippedBlocks += 1
      if (res.matches > 0) {
        o.matches += res.matches
        o.blocks += 1
        o.removedChars += res.removedChars
        report.savedChars += res.removedChars
        cur = res.text
      }
    })
    return cur
  }

  if (compiled.length > 0) {
    for (let i = liveStart; i < entries.length; i++) {
      const e = entries[i] as Entry
      if (e.removed || !e.obj || e.obj['isSidechain'] === true) continue
      const role = roleOf(e)
      const msg = messageOf(e)
      if (!role || !msg) continue
      const content = msg['content']

      if (typeof content === 'string') {
        const next = runRules(content, role, undefined)
        if (next !== content) {
          touch(i)
          if (next.trim() === '') e.removed = true
          else msg['content'] = next
        }
        continue
      }
      if (!Array.isArray(content)) continue
      for (const b of [...(content as Json[])]) {
        if (!isRecord(b)) continue
        if (b['type'] === 'text' && typeof b['text'] === 'string') {
          const next = runRules(b['text'], role, undefined)
          if (next !== b['text']) {
            touch(i)
            if (next.trim() === '') (content as Json[]).splice((content as Json[]).indexOf(b), 1)
            else b['text'] = next
          }
        } else if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
          const id = b['tool_use_id']
          if (trimIds.has(id)) continue
          const rc = b['content']
          if (typeof rc === 'string') {
            const next = runRules(rc, role, id)
            if (next !== rc) {
              touch(i)
              b['content'] = next.trim() === '' ? '[Trimmed: all content removed by regex_rules]' : next
            }
          } else if (Array.isArray(rc)) {
            for (const p of rc as Json[]) {
              if (isRecord(p) && p['type'] === 'text' && typeof p['text'] === 'string') {
                const next = runRules(p['text'], role, id)
                if (next !== p['text']) {
                  touch(i)
                  p['text'] = next.trim() === '' ? '[Trimmed: all content removed by regex_rules]' : next
                }
              }
            }
          }
        }
      }
      if ((content as Json[]).length === 0) e.removed = true
    }
  }
  report.rules = outcomes

  report.changed = report.stubbed.length > 0 || report.deleted.length > 0 || outcomes.some((o) => o.matches > 0)

  // ── 3. collapse the trim_session turn(s) into the session note ─────────────
  for (const id of trimIds) {
    const rs = results.get(id)
    const us = uses.get(id)
    if (!rs || rs.length === 0) return { ok: false, error: `The trim_session result (${id}) is not in the transcript yet.` }
    for (const r of rs) {
      r.block['content'] = request.note
      delete r.block['is_error']
      const e = entries[r.entry] as Entry
      // The line also carries a structured duplicate of the result for the UI; for our own
      // MCP tool that is plain text, so it must not keep the stale "queued" wording.
      if (e.obj && 'toolUseResult' in e.obj) e.obj['toolUseResult'] = request.note
      touch(r.entry)
    }
    for (const u of us ?? []) {
      u.block['input'] = {}
      touch(u.entry)
    }
    report.collapsedTrimCalls += 1
  }

  // ── 3b. earlier flagging calls that are fully settled ───────────────────────
  // They are removed outright (tool_use and tool_result together): nothing reads them any more and the
  // agent was told what happened. Never one that sits BEFORE the first change above: clearing it would
  // move the rewrite point back and invalidate more cache than the economics priced.
  for (const id of ctx.settledCallIds ?? []) {
    if (trimIds.has(id) || deletedIds.has(id)) continue
    const rs = results.get(id) ?? []
    const us = uses.get(id) ?? []
    if (rs.length === 0 && us.length === 0) {
      report.settledCleared.push(id) // no longer in the transcript: nothing left to clear
      continue
    }
    if (rs.length === 0 || us.length === 0) continue
    const first = Math.min(...rs.map((r) => r.entry), ...us.map((u) => u.entry))
    if (!Number.isFinite(earliest) || first <= earliest) continue
    const chars = rs.reduce((n, r) => n + resultText(r.block).text.length, 0) + us.reduce((n, u) => n + JSON.stringify(u.block['input'] ?? {}).length, 0)
    for (const r of rs) dropBlock(r)
    for (const u of us) dropBlock(u)
    deletedIds.add(id)
    report.settledCleared.push(id)
    report.savedChars += chars
  }

  // ── 4. strip thinking blocks from the earliest change onward ───────────────
  if (Number.isFinite(earliest)) {
    for (let i = earliest; i < entries.length; i++) {
      const e = entries[i] as Entry
      if (e.removed || roleOf(e) !== 'assistant') continue
      const content = contentArray(e)
      if (!content) continue
      const kept = content.filter((b) => !(isRecord(b) && isThinking(b)))
      if (kept.length !== content.length) {
        report.thinkingBlocksStripped += content.length - kept.length
        const msg = messageOf(e) as Json
        msg['content'] = kept
        touch(i)
        if (kept.length === 0) e.removed = true
      }
    }
  }

  // ── 5. repair the parentUuid chain around removed lines ────────────────────
  const removedParent = new Map<string, string | null>()
  for (const e of entries) {
    if (e.removed) {
      report.linesRemoved += 1
      const u = e.obj?.['uuid']
      if (typeof u === 'string') removedParent.set(u, typeof e.obj?.['parentUuid'] === 'string' ? (e.obj['parentUuid'] as string) : null)
    }
  }
  if (removedParent.size > 0) {
    const resolve = (start: string): string | null => {
      let cur: string | null = start
      const seen = new Set<string>()
      while (cur !== null && removedParent.has(cur) && !seen.has(cur)) {
        seen.add(cur)
        cur = removedParent.get(cur) ?? null
      }
      return cur
    }
    entries.forEach((e, i) => {
      if (e.removed || !e.obj) return
      const p = e.obj['parentUuid']
      if (typeof p === 'string' && removedParent.has(p)) {
        e.obj['parentUuid'] = resolve(p)
        report.parentLinksRepaired += 1
        touch(i)
      }
    })
  }

  // ── 6. invariants: no orphans, no empty messages ───────────────────────────
  const uses2 = new Set<string>()
  const results2 = new Set<string>()
  for (const e of entries) {
    if (e.removed || !e.obj) continue
    const content = contentArray(e)
    if (!content) {
      const m = messageOf(e)
      if (m && Array.isArray(m['content']) && (m['content'] as unknown[]).length === 0) return { ok: false, error: 'Internal check failed: a message would be left empty.' }
      continue
    }
    if (content.length === 0) return { ok: false, error: 'Internal check failed: a message would be left empty.' }
    for (const b of content) {
      if (!isRecord(b)) continue
      if (b['type'] === 'tool_use' && typeof b['id'] === 'string') uses2.add(b['id'])
      if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') results2.add(b['tool_use_id'])
    }
  }
  for (const id of deletedIds) {
    if (uses2.has(id) || results2.has(id)) return { ok: false, error: `Internal check failed: ${id} was not fully deleted.` }
  }
  for (const id of pairedBefore) {
    if (uses2.has(id) !== results2.has(id)) return { ok: false, error: `Internal check failed: tool_use/tool_result pair ${id} would be orphaned.` }
  }
  for (const id of results2) {
    if (!uses2.has(id) && uses.has(id)) return { ok: false, error: `Internal check failed: tool_result ${id} would be orphaned.` }
  }

  // ── serialise ──────────────────────────────────────────────────────────────
  const lines: string[] = []
  entries.forEach((e) => {
    if (e.removed) return
    lines.push(e.dirty && e.obj ? JSON.stringify(e.obj) : e.raw)
  })
  return { ok: true, lines, changedFrom: Number.isFinite(earliest) ? earliest : lines.length, report }
}
