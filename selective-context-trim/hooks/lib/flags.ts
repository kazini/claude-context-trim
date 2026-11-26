import { oneLine } from './format.ts'
import { escapeRegExp, pointerFor, spanPointerFor } from './redundancy.ts'
import type { Finding, FindingKind } from './redundancy.ts'
import type { Rule, Target, TrimRequest } from './types.ts'

/**
 * A flag is the agent's intent to trim something, held until it pays off. Flags are cheap to make and
 * safe to leave: nothing is applied until the cache economics (or an expired cache) allow it.
 */
export interface Flag {
  /** Short handle the agent can use to unflag: f1, f2… */
  id: string
  target?: Target
  rule?: Rule
  /** The trim_session call (tool_use id) that made this flag. Absent for automatic flags. */
  callId?: string
  /** The session note to leave where that call was, if it was made by the agent. */
  note?: string
  /** Set on flags the plugin made itself (redundant older copies, or its own tool results). */
  auto?: AutoInfo
}

/** Why the plugin flagged something on its own. */
export interface AutoInfo {
  kind: FindingKind | 'own-tool'
  /** The older result that gets trimmed. */
  oldId: string
  /** The newer result that keeps the content. */
  newId: string
  coverage: number
  /** Lines in the span (sections only). */
  lines?: number
}

/** A rule can wait only if it is pinned to specific results; an unscoped one would also hit text that does not exist yet. */
export function deferrable(rule: Rule): boolean {
  return (rule.scopeToolIds?.length ?? 0) > 0
}

export interface FlagCounter {
  n: number
}

/**
 * Add targets and rules. Re-flagging something that is already flagged silently replaces that flag in
 * place (same id, new mode/replacement): no "already flagged" chatter, no second flag, no extra call left open.
 */
export function addFlags(existing: readonly Flag[], targets: readonly Target[], rules: readonly Rule[], counter: FlagCounter, callId?: string, note?: string): Flag[] {
  const out = [...existing]
  const by = callId ? { callId } : {}
  for (const target of targets) {
    const at = out.findIndex((f) => f.target?.id === target.id)
    if (at >= 0) {
      const id = out[at]!.id
      out[at] = { id, target, ...(note ? { note } : {}), ...by }
      continue
    }
    counter.n += 1
    out.push({ id: `f${counter.n}`, target, ...(note ? { note } : {}), ...by })
  }
  for (const rule of rules) {
    const scope = (rule.scopeToolIds ?? []).join(',')
    const at = out.findIndex((f) => f.rule !== undefined && f.rule.pattern === rule.pattern && (f.rule.scopeToolIds ?? []).join(',') === scope)
    if (at >= 0) {
      const id = out[at]!.id
      out[at] = { id, rule, ...(note ? { note } : {}), ...by }
      continue
    }
    counter.n += 1
    out.push({ id: `f${counter.n}`, rule, ...(note ? { note } : {}), ...by })
  }
  return out
}

/** Remove by flag id (f3) or by tool_use_id. */
export function removeFlags(flags: readonly Flag[], keys: readonly string[]): { flags: Flag[]; removed: Flag[] } {
  const hit = (f: Flag) => keys.includes(f.id) || (f.target !== undefined && keys.includes(f.target.id)) || (f.rule?.scopeToolIds ?? []).some((id) => keys.includes(id))
  return { flags: flags.filter((f) => !hit(f)), removed: flags.filter(hit) }
}

export function requestFromFlags(flags: readonly Flag[], note: string): TrimRequest {
  return {
    targets: flags.flatMap((f) => (f.target ? [f.target] : [])),
    rules: flags.flatMap((f) => (f.rule ? [f.rule] : [])),
    note,
  }
}

/** Tool ids a flag touches (used to drop flags whose results no longer exist). */
export function flagToolIds(f: Flag): string[] {
  if (f.target) return [f.target.id]
  return f.rule?.scopeToolIds ?? []
}

export function describeFlag(f: Flag): string {
  if (f.auto) {
    const a = f.auto
    if (a.kind === 'own-tool') return `${f.id} auto: delete this plugin's own result ${a.oldId}`
    return a.kind === 'section'
      ? `${f.id} auto: ${a.lines ?? '?'} duplicate lines of ${a.oldId} (kept in newer ${a.newId})`
      : `${f.id} auto: ${a.oldId} ${a.kind === 'duplicate' ? 'identical to' : 'superseded by'} newer ${a.newId} (${Math.round(a.coverage * 100)}% shared)`
  }
  if (f.target) {
    const t = f.target
    return `${f.id} ${t.mode} ${t.id}${t.mode === 'summary' && t.replacement ? ` → "${oneLine(t.replacement, 60)}"` : ''}`
  }
  const r = f.rule!
  return `${f.id} regex /${oneLine(r.pattern, 40)}/ ${r.mode} on ${(r.scopeToolIds ?? []).join(',')}`
}

export function describeFlags(flags: readonly Flag[]): string {
  return flags.map(describeFlag).join('; ')
}

/** Turn an already-built request back into flags (so a second call can add to a queued one). */
export function flagsFromRequest(request: TrimRequest, counter: FlagCounter): Flag[] {
  const out: Flag[] = []
  for (const target of request.targets) out.push({ id: `f${++counter.n}`, target })
  for (const rule of request.rules) out.push({ id: `f${++counter.n}`, rule })
  return out
}

// ── automatic flags (redundancy) ─────────────────────────────────────────────

/**
 * Flags for the findings the harness may act on without asking: whole older results become a
 * `summary` target that points at the newer copy; matching sections become a literal, scoped rule.
 * Skips anything the agent vetoed (unflagged), anything already flagged, and anything pinned to a
 * result that is not an ordinary tool result.
 */
export function autoFlagsFromFindings(
  findings: readonly Finding[],
  existing: readonly Flag[],
  vetoed: ReadonlySet<string>,
  counter: FlagCounter,
): Flag[] {
  const out: Flag[] = []
  const has = (pred: (f: Flag) => boolean) => existing.some(pred) || out.some(pred)
  for (const f of findings) {
    if (f.confidence !== 'auto' || f.oldKind !== 'tool' || vetoed.has(f.oldId)) continue
    if (has((x) => x.target?.id === f.oldId)) continue
    if (f.kind !== 'section') {
      counter.n += 1
      out.push({
        id: `f${counter.n}`,
        target: { id: f.oldId, mode: 'summary', replacement: pointerFor(f) },
        auto: { kind: f.kind, oldId: f.oldId, newId: f.newId, coverage: f.coverage },
      })
      continue
    }
    for (const span of f.spans ?? []) {
      const pattern = escapeRegExp(span.text)
      if (has((x) => x.rule?.pattern === pattern && (x.rule.scopeToolIds ?? []).includes(f.oldId))) continue
      counter.n += 1
      out.push({
        id: `f${counter.n}`,
        rule: { pattern, flags: '', scopeToolIds: [f.oldId], mode: 'summary', replacement: spanPointerFor(f, span) },
        auto: { kind: 'section', oldId: f.oldId, newId: f.newId, coverage: f.coverage, lines: span.lines },
      })
    }
  }
  return out
}

/**
 * Flags for this plugin's own inspect_session / trim_session results. They are metadata about the
 * trimming session itself, so every older one can go; the newest one is left alone by the caller
 * (its output is the last thing the agent reads). Like all automatic flags they can be unflagged.
 */
export function ownToolFlags(
  ids: readonly string[],
  existing: readonly Flag[],
  vetoed: ReadonlySet<string>,
  counter: FlagCounter,
): Flag[] {
  const out: Flag[] = []
  const has = (id: string) => existing.some((f) => f.target?.id === id || (f.rule?.scopeToolIds ?? []).includes(id)) || out.some((f) => f.target?.id === id)
  for (const id of ids) {
    if (vetoed.has(id) || has(id)) continue
    counter.n += 1
    out.push({
      id: `f${counter.n}`,
      target: { id, mode: 'delete' },
      auto: { kind: 'own-tool', oldId: id, newId: id, coverage: 1 },
    })
  }
  return out
}

/**
 * An automatic flag only makes sense while the newer copy that keeps the content is still in the
 * context, untouched. Drop those whose winner is gone, already trimmed, or itself flagged.
 */
export function dropInvalidAuto(flags: readonly Flag[], isLive: (toolId: string) => boolean): Flag[] {
  const touched = (id: string, except: Flag) => flags.some((o) => o !== except && (o.target?.id === id || (o.rule?.scopeToolIds ?? []).includes(id)))
  return flags.filter((f) => !f.auto || (isLive(f.auto.newId) && !touched(f.auto.newId, f)))
}

export function autoCount(flags: readonly Flag[]): number {
  return flags.filter((f) => f.auto).length
}

/**
 * trim_session calls whose flags are all resolved (applied, unflagged or obsolete): their input
 * (regexes, replacement text) is dead weight, so the next rewrite clears them.
 */
export function settledCalls(open: ReadonlySet<string>, remaining: readonly Flag[]): string[] {
  const live = new Set(remaining.map((f) => f.callId).filter((x): x is string => x !== undefined))
  return [...open].filter((id) => !live.has(id))
}
