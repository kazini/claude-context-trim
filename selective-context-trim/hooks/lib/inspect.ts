import { adviceFor, DEFAULT_ECON, isLive, judge, tokensOf, writeMult } from './economics.ts'
import type { CacheState, EconConfig, Reentry, Verdict } from './economics.ts'
import { countLines, fmtInt, fmtTok, jsonLength, oneLine, toolLabel } from './format.ts'
import { applyRuleToText, compileRule } from './regex.ts'
import type { Msg, Role, TrimRequest, UsageLike } from './types.ts'

/** Tools of this plugin are never trim candidates (their results are meta-noise). */
export const OWN_TOOL_PREFIX = 'mcp__selective-context-trim__'

const STUB_TOKENS = 40
const SUMMARY_OVERHEAD_TOKENS = 12
/** Below this a result is not worth naming in a recommended set. */
const RECOMMEND_FLOOR_TOKENS = 1500

export interface Block {
  kind: 'tool' | 'text'
  /** Index of the message (in the analysed window) the block belongs to. */
  msg: number
  role: Role
  id?: string
  tool?: string
  label?: string
  /** Message holding the tool_result (== msg when the engine reports results on the assistant side). */
  resultMsg?: number
  bodyChars: number
  bodyLines: number
  /** Chars of the tool_use itself (name + input). */
  useChars: number
  isError: boolean
  alreadyTrimmed: boolean
  preview?: string
}

export interface Analysis {
  messages: Msg[]
  blocks: Block[]
  msgStart: number[]
  msgEnd: number[]
  /** Cumulative content-block count through each message. */
  blockEnd: number[]
  totalChars: number
  totalBlocks: number
  windowTokens: number
  contextTokens: number
  /** Tokens before the first analysed message: system, tools, memory, anything older than the window. */
  overheadTokens: number
  percent?: number
  contextWindow?: number
  bodyById: Map<string, { text: string; msg: number }>
  cfg: EconConfig
  cache: CacheState
  /**
   * Blocks that will exist by the next request but do not yet: the rest of this tool round trip,
   * the closing message and the continuation prompt. They push the cache anchor further from the
   * end, so reachability is judged with them counted.
   */
  futureBlocks: number
}

function resultTextOf(m: Msg | undefined, id: string): string | undefined {
  return m?.toolResults?.find((r) => r.tool_use_id === id)?.text
}

export const DEFAULT_CACHE: CacheState = { ttl: '5m', readMult: 0.1 }

export function analyzeSession(
  messages: readonly Msg[],
  usage: UsageLike | undefined,
  cfg: EconConfig = DEFAULT_ECON,
  cache: CacheState = DEFAULT_CACHE,
  futureBlocks = 0,
): Analysis {
  const resultsInUser = messages.some((m) => (m.toolResults?.length ?? 0) > 0)
  const resultMsgOf = new Map<string, number>()
  if (resultsInUser) {
    messages.forEach((m, i) => m.toolResults?.forEach((r) => resultMsgOf.set(r.tool_use_id, i)))
  }

  const msgStart: number[] = []
  const msgEnd: number[] = []
  const blockEnd: number[] = []
  let total = 0
  let blocksTotal = 0
  const blocks: Block[] = []
  const bodyById = new Map<string, { text: string; msg: number }>()

  messages.forEach((m, i) => {
    msgStart.push(total)
    let chars = m.text.length
    let nBlocks = m.text.length > 0 ? 1 : 0
    for (const u of m.toolUses) {
      chars += u.tool.length + jsonLength(u.input)
      nBlocks += 1
      if (!resultsInUser) {
        chars += u.text?.length ?? 0
        nBlocks += 1
      }
    }
    for (const r of m.toolResults ?? []) {
      chars += r.text?.length ?? 0
      nBlocks += 1
    }
    total += chars
    blocksTotal += nBlocks
    msgEnd.push(total)
    blockEnd.push(blocksTotal)

    for (const u of m.toolUses) {
      const body = (resultsInUser ? resultTextOf(messages[resultMsgOf.get(u.tool_use_id) ?? -1], u.tool_use_id) : u.text) ?? u.text ?? ''
      const rm = resultsInUser ? (resultMsgOf.get(u.tool_use_id) ?? i) : i
      bodyById.set(u.tool_use_id, { text: body, msg: rm })
      blocks.push({
        kind: 'tool',
        msg: i,
        role: 'assistant',
        id: u.tool_use_id,
        tool: u.tool,
        label: toolLabel(u.tool, u.input),
        resultMsg: rm,
        bodyChars: body.length,
        bodyLines: countLines(body),
        useChars: u.tool.length + jsonLength(u.input),
        isError: u.isError === true,
        alreadyTrimmed: body.startsWith('[Trimmed') || body.startsWith('Agent pruned context'),
      })
    }
    if (m.text.length > 0) {
      blocks.push({
        kind: 'text',
        msg: i,
        role: m.role,
        bodyChars: m.text.length,
        bodyLines: countLines(m.text),
        useChars: 0,
        isError: false,
        alreadyTrimmed: m.text.startsWith('[Trimmed'),
        preview: oneLine(m.text, 70),
      })
    }
  })

  const windowTokens = tokensOf(total, cfg)
  const contextTokens = Math.max(usage?.tokens ?? 0, windowTokens + (usage?.tokens ? 0 : 20000))

  // Where does the analysed window start in the real prompt? The API told us how big the
  // last request's prompt was; everything before the messages it ended on is "overhead".
  let overhead = Math.max(0, contextTokens - windowTokens)
  const api = usage?.apiUsage
  if (api) {
    const prompt = (api.input_tokens ?? 0) + (api.cache_read_input_tokens ?? 0) + (api.cache_creation_input_tokens ?? 0)
    let lastUser = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') {
        lastUser = i
        break
      }
    }
    if (prompt > 0 && lastUser >= 0) overhead = Math.max(0, prompt - tokensOf(msgEnd[lastUser] ?? 0, cfg))
  }

  return {
    messages: [...messages],
    blocks,
    msgStart,
    msgEnd,
    blockEnd,
    totalChars: total,
    totalBlocks: blocksTotal,
    windowTokens,
    contextTokens,
    overheadTokens: overhead,
    ...(usage?.percent !== undefined ? { percent: usage.percent } : {}),
    ...(usage?.window ? { contextWindow: usage.window } : {}),
    bodyById,
    cfg,
    cache,
    futureBlocks,
  }
}

/**
 * Where can the next request re-enter the cache if the first change is in message
 * `msgIdx`? Each earlier request left an entry at the end of its prompt, i.e. at the
 * end of a user message; those before the change survive. The API only finds one
 * within `lookbackBlocks` of the new end — otherwise only system+tools are read.
 */
export function reentryFor(a: Analysis, msgIdx: number): Reentry {
  const fixed = Math.min(a.overheadTokens, a.cfg.fixedPrefixTokens)
  const posTok = a.overheadTokens + tokensOf(a.msgStart[msgIdx] ?? 0, a.cfg)
  let j = -1
  for (let i = msgIdx - 1; i >= 0; i--) {
    if (a.messages[i]?.role === 'user') {
      j = i
      break
    }
  }
  const blocksAfter = a.totalBlocks - (j >= 0 ? (a.blockEnd[j] ?? 0) : 0) + a.futureBlocks
  const reachable = j >= 0 && blocksAfter <= a.cfg.lookbackBlocks
  const anchorTokens = reachable ? a.overheadTokens + tokensOf(a.msgEnd[j] ?? 0, a.cfg) : fixed
  return {
    anchorTokens,
    gapTokens: Math.max(0, posTok - anchorTokens),
    recomputeTokens: Math.max(0, a.contextTokens - anchorTokens),
    blocksAfterAnchor: blocksAfter,
    reachable,
    anchorMsg: reachable ? j : -1,
  }
}

type Mode = 'stub' | 'summary' | 'delete'

/** Message index holding the first token a change to this block would alter. */
function posMsg(b: Block, mode: Mode): number {
  if (b.kind === 'tool') return mode === 'delete' ? b.msg : (b.resultMsg ?? b.msg)
  return b.msg
}

/** Message index of the first change a flag (a target, or a rule pinned to tool results) would make; Infinity if unknown. */
export function positionOf(a: Analysis, target: { id: string; mode: Mode } | undefined, scopeToolIds: readonly string[] = []): number {
  if (target) {
    const b = a.blocks.find((x) => x.kind === 'tool' && x.id === target.id)
    return b ? posMsg(b, target.mode) : Infinity
  }
  const at = scopeToolIds.map((id) => a.bodyById.get(id)?.msg).filter((m): m is number => m !== undefined)
  return at.length > 0 ? Math.min(...at) : Infinity
}

function savedTokens(a: Analysis, b: Block, mode: Mode, replacement?: string): number {
  const body = tokensOf(b.bodyChars, a.cfg)
  if (mode === 'delete') return body + tokensOf(b.useChars, a.cfg) + 10
  if (mode === 'summary') return Math.max(0, body - tokensOf((replacement ?? '').length, a.cfg) - SUMMARY_OVERHEAD_TOKENS)
  return Math.max(0, body - STUB_TOKENS)
}

function judgeAt(a: Analysis, S: number, msgIdx: number, extra: { items?: number; expectedRequests?: number } = {}): Verdict {
  return judge(
    {
      S,
      C: a.contextTokens,
      reentry: reentryFor(a, msgIdx),
      ...(a.percent !== undefined ? { percent: a.percent } : {}),
      ...(extra.items !== undefined ? { items: extra.items } : {}),
      ...(extra.expectedRequests !== undefined ? { expectedRequests: extra.expectedRequests } : {}),
    },
    a.cache,
    a.cfg,
  )
}

export interface Candidate {
  block: Block
  saved: number
  msg: number
  alone: Verdict
}

export interface Recommendation {
  set: Candidate[]
  verdict: Verdict
}

export function candidatesOf(a: Analysis, minTokens: number): Candidate[] {
  const out: Candidate[] = []
  for (const b of a.blocks) {
    if (b.kind !== 'tool' || b.alreadyTrimmed) continue
    if (b.tool?.startsWith(OWN_TOOL_PREFIX)) continue
    if (tokensOf(b.bodyChars, a.cfg) < minTokens) continue
    const saved = savedTokens(a, b, 'stub')
    const msg = posMsg(b, 'stub')
    out.push({ block: b, saved, msg, alone: judgeAt(a, saved, msg) })
  }
  return out
}

/**
 * Best set to trim together. The cost depends only on the EARLIEST message touched
 * (everything after the re-entry anchor is recomputed anyway), so once you pay for
 * a position every newer candidate is free to add: the optimal set is a "suffix" of
 * the candidates ordered by position. Evaluate each suffix, keep the best that
 * clears the standards.
 */
export function recommend(a: Analysis, cands: Candidate[]): Recommendation | undefined {
  const byNewest = cands.filter((c) => tokensOf(c.block.bodyChars, a.cfg) >= RECOMMEND_FLOOR_TOKENS).sort((x, y) => y.msg - x.msg)
  let sum = 0
  let best: Recommendation | undefined
  let bestGain = -Infinity
  const set: Candidate[] = []
  for (const c of byNewest) {
    set.push(c)
    sum += c.saved
    const v = judgeAt(a, sum, c.msg)
    // The recommendation is a quick, recent clean-up. Once the earliest change would be beyond the
    // cache lookback, every older candidate is too: stop (see deliberateCleanup for that case).
    if (v.reentry && !v.reentry.reachable) break
    if (v.zone === 'good' && v.standard !== 'none' && v.longTerm > bestGain) {
      bestGain = v.longTerm
      best = { set: [...set], verdict: v }
    }
  }
  return best
}

/**
 * The deliberate, manual cross-history clean-up: every sizeable result at once, reaching beyond
 * the cache lookback. Only offered when it passes the sizeable/batch standard on its long-term numbers.
 */
export function deliberateCleanup(a: Analysis, cands: Candidate[], expectedRequests?: number): Recommendation | undefined {
  const all = cands.filter((c) => tokensOf(c.block.bodyChars, a.cfg) >= RECOMMEND_FLOOR_TOKENS)
  if (all.length < 2) return undefined
  const earliest = Math.min(...all.map((c) => c.msg))
  const S = all.reduce((n, c) => n + c.saved, 0)
  const v = judgeAt(a, S, earliest, { items: all.length, ...(expectedRequests !== undefined ? { expectedRequests } : {}) })
  if (v.zone !== 'good' || v.standard === 'none' || (v.reentry && v.reentry.reachable)) return undefined
  return { set: all, verdict: v }
}

export interface InspectOptions {
  minTokens: number
  maxRows: number
  includeText: boolean
}

function cacheLine(a: Analysis): string {
  const live = isLive(a.cache)
  const age = a.cache.ageMs === undefined ? 'age unknown' : `last used ${Math.round(a.cache.ageMs / 1000)}s ago`
  return `Cache: ${live ? 'live' : 'EXPIRED'} (${age}, ttl ${a.cache.ttl}, write ${writeMult(a.cache.ttl)}x / read ${a.cache.readMult}x, ${a.cfg.lookbackBlocks}-block lookback)`
}

/** A message text block is only worth listing as a trim candidate from this size up: short prompts are not. */
const TEXT_CANDIDATE_TOKENS = 1000

export function renderInspect(a: Analysis, opts: InspectOptions): string {
  const lines: string[] = []
  const pct = a.percent !== undefined ? ` (${a.percent}%${a.contextWindow ? ` of ${fmtTok(a.contextWindow)}` : ''})` : ''
  lines.push(
    `Context ≈${fmtTok(a.contextTokens)} tok${pct}. Inspected last ${a.messages.length} messages (≈${fmtTok(a.windowTokens)} tok, ${a.totalBlocks} blocks). ${cacheLine(a)}. ` +
      `Horizon ${a.cfg.assumedRemainingRequests} requests.`,
  )

  const cands = candidatesOf(a, opts.minTokens)
  const rec = recommend(a, cands)
  const star = new Set(rec?.set.map((c) => c.block.id))
  if (rec) {
    lines.push(`★ Recommended set (${rec.set.length} result${rec.set.length === 1 ? '' : 's'}, mode "stub", passes the ${rec.verdict.standard} standard): ${rec.verdict.summary}.`)
  } else if (cands.length > 0) {
    lines.push('No set is worth trimming right now: each candidate would force more recomputation than it saves (or saves too little). Keep working; revisit after the next large tool result.')
  } else {
    const biggest = a.blocks.reduce((m, b) => (b.kind === 'tool' && !b.alreadyTrimmed ? Math.max(m, tokensOf(b.bodyChars, a.cfg)) : m), 0)
    // Say it plainly: a model that was asked to trim reads "nothing found" as "look harder" and keeps calling.
    lines.push(`Nothing here is worth trimming: no tool result is large enough (the biggest is ≈${fmtTok(biggest)} tok; this call looked at ≥${opts.minTokens}). No action needed: carry on with your task.`)
  }

  const newest = [...cands].sort((x, y) => y.msg - x.msg)
  // every starred id must be listed, however many rows were asked for
  const shown = newest.filter((c, i) => i < opts.maxRows || star.has(c.block.id))
  if (shown.length > 0) {
    lines.push('', 'Tool results, newest first. recompute = share of the context the next request must reprocess if that item alone is trimmed (counted from the nearest surviving cache entry; beyond the lookback it is the whole conversation).')
    lines.push('  ' + ['tool_use_id', 'msg', 'call', '≈tok', 'lines', 'chars', 'recompute', 'alone'].join(' | '))
    for (const c of shown) {
      const b = c.block
      lines.push(
        `${star.has(b.id) ? '★' : ' '} ${[
          b.id,
          `#${b.msg}`,
          b.label,
          fmtTok(tokensOf(b.bodyChars, a.cfg)),
          fmtInt(b.bodyLines),
          fmtInt(b.bodyChars),
          `${Math.round(c.alone.reach * 100)}%`,
          c.alone.zone + (b.isError ? ',error' : ''),
        ].join(' | ')}`,
      )
    }
    if (cands.length > shown.length) lines.push(`… ${cands.length - shown.length} older candidates not shown (raise max_rows).`)
  }

  const cleanup = deliberateCleanup(a, cands)
  if (cleanup && (!rec || cleanup.set.length > rec.set.length)) {
    lines.push(
      '',
      `Deliberate cross-history clean-up (NOT recommended by default; only if you truly no longer need ANY of these ${cleanup.set.length} results): ${cleanup.verdict.summary} — passes the ${cleanup.verdict.standard} standard. List them with a larger max_rows.`,
    )
  }
  const trimmed = a.blocks.filter((b) => b.kind === 'tool' && b.alreadyTrimmed).length
  if (trimmed > 0) lines.push(`(${trimmed} tool result${trimmed === 1 ? '' : 's'} already trimmed.)`)

  if (opts.includeText) {
    const textFloor = Math.max(opts.minTokens, TEXT_CANDIDATE_TOKENS)
    const texts = a.blocks
      .filter((b) => b.kind === 'text' && !b.alreadyTrimmed && tokensOf(b.bodyChars, a.cfg) >= textFloor)
      .sort((x, y) => y.msg - x.msg)
      .slice(0, 6)
    if (texts.length > 0) {
      lines.push('', 'Large text blocks (candidates for regex_rules):')
      for (const t of texts) {
        lines.push(`  #${t.msg} ${t.role} ≈${fmtTok(tokensOf(t.bodyChars, a.cfg))} tok, ${fmtInt(t.bodyLines)} lines: ${t.preview}`)
      }
    }
  }
  if (shown.length > 0 || cands.length > 0) {
    lines.push('', 'Reminder: stubbed results are gone. Record any facts you still need in your reply first, or use mode "summary". If you later need the exact text of a trimmed file (e.g. to write an Edit), Read it again.')
  }
  return lines.join('\n')
}

/** Length of the longest common subsequence: tolerant of characters a model drops while copying a long id. */
function lcs(x: string, y: string): number {
  let prev: number[] = new Array<number>(y.length + 1).fill(0)
  for (let i = 1; i <= x.length; i++) {
    const cur: number[] = new Array<number>(y.length + 1).fill(0)
    for (let j = 1; j <= y.length; j++) cur[j] = x[i - 1] === y[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, cur[j - 1] as number)
    prev = cur
  }
  return prev[y.length] as number
}

/**
 * What to say when an id is not found. Some models cannot copy a long tool_use_id exactly, and telling them to
 * look it up again does not help: give them the closest valid id and the biggest recent results right here.
 */
export function idHelp(a: Analysis, wanted: string): string {
  const pool = a.blocks.filter((b) => b.kind === 'tool' && b.id !== undefined && !b.alreadyTrimmed && !b.tool?.startsWith(OWN_TOOL_PREFIX))
  if (pool.length === 0) return 'There is no untrimmed tool result in that window.'
  const show = (b: (typeof pool)[number]) => `${b.id} (${b.label}, ≈${fmtTok(tokensOf(b.bodyChars, a.cfg))} tok)`
  let best: (typeof pool)[number] | undefined
  let bestScore = 0
  for (const b of pool) {
    const score = lcs(wanted, b.id as string) / Math.max(wanted.length, 1)
    if (score > bestScore) {
      best = b
      bestScore = score
    }
  }
  const largest = [...pool].sort((x, y) => y.bodyChars - x.bodyChars).slice(0, 3)
  const closest = best && bestScore >= 0.6 ? `Closest valid id: ${show(best)}. ` : ''
  return `${closest}Largest results: ${largest.map(show).join('; ')}. Copy the id exactly, character for character.`
}

export interface PlanEstimate {
  /** Estimated tokens removed. */
  S: number
  /** Where the next request can re-enter the cache for the earliest change. */
  reentry: Reentry | undefined
  /** Targets + rules asked for (a deliberate batch cleans many at once). */
  items: number
  errors: string[]
  warnings: string[]
}

/** Pre-flight estimate of a validated request against the live message list. */
export function estimatePlan(a: Analysis, request: TrimRequest): PlanEstimate {
  const errors: string[] = []
  const warnings: string[] = []
  let S = 0
  let earliest = Infinity
  const touch = (msg: number) => {
    earliest = Math.min(earliest, msg)
  }

  for (const t of request.targets) {
    const b = a.blocks.find((x) => x.kind === 'tool' && x.id === t.id)
    if (!b) {
      errors.push(`tool_use_id ${t.id} was not found among the ${a.messages.length} most recent messages inspected (wrong id, or too old to trim economically). ${idHelp(a, t.id)}`)
      continue
    }
    if (b.alreadyTrimmed) {
      warnings.push(`${t.id} is already trimmed; skipped.`)
      continue
    }
    S += savedTokens(a, b, t.mode, t.replacement)
    touch(posMsg(b, t.mode))
  }

  if (request.rules.length > 0) {
    const compiled = request.rules.map((r) => ({ r, re: compileRule(r.pattern, r.flags) }))
    let totalMatches = 0
    const scan = (text: string, role: Role, toolId: string | undefined, msg: number) => {
      for (const { r, re } of compiled) {
        if (r.scopeRoles && !r.scopeRoles.includes(role)) continue
        if (r.scopeToolIds && (!toolId || !r.scopeToolIds.includes(toolId))) continue
        const res = applyRuleToText(text, re, r.mode, r.replacement)
        if (res.matches > 0) {
          totalMatches += res.matches
          S += tokensOf(res.removedChars, a.cfg)
          if (res.removedChars > 0) touch(msg)
        }
      }
    }
    a.messages.forEach((m, i) => {
      if (m.text) scan(m.text, m.role, undefined, i)
    })
    for (const b of a.blocks) {
      if (b.kind !== 'tool' || b.tool?.startsWith(OWN_TOOL_PREFIX)) continue
      const body = a.bodyById.get(b.id ?? '')
      if (body?.text) scan(body.text, 'user', b.id, body.msg)
    }
    if (S === 0 && request.targets.length === 0) {
      warnings.push(
        totalMatches > 0
          ? `regex_rules matched ${totalMatches} time(s), but each match is shorter than its replacement, so nothing would shrink: use mode "delete", or match whole blocks such as (?:...\\n)+.`
          : 'No regex_rules matched anything in the recent messages.',
      )
    }
  }

  return {
    S: Math.round(S),
    reentry: Number.isFinite(earliest) ? reentryFor(a, earliest) : undefined,
    items: request.targets.length + request.rules.length,
    errors,
    warnings,
  }
}

export { adviceFor }
