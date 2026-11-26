import { isRecord } from './format.ts'
import { compileRule, normalizeFlags } from './regex.ts'
import type { Role, Rule, Target, TrimMode, TrimRequest } from './types.ts'

export const DEFAULT_NOTE = 'Agent pruned context: success'

export const LIMITS = {
  maxTargets: 40,
  maxRules: 12,
  maxPatternChars: 400,
  maxReplacementChars: 600,
  maxNoteChars: 300,
  maxScopeIds: 40,
} as const

const MODES: readonly string[] = ['stub', 'summary', 'delete']
const ROLES: readonly string[] = ['user', 'assistant']
const ID_RE = /^[A-Za-z0-9_-]{4,128}$/

interface Atom {
  /** Can this atom match a newline? */
  crosses: boolean
  /** Unbounded repetition (* + {n,}). */
  unbounded: boolean
  /** `{0,…}`, `?` or `*`: may match nothing. */
  optional: boolean
  /** A literal \n escape. */
  literalNewline: boolean
}

/** Split a group body into atoms with their quantifiers; null when it holds alternation or nesting. */
function atomsOf(body: string, flags: string): Atom[] | null {
  const out: Atom[] = []
  let i = 0
  while (i < body.length) {
    let crosses = false
    let literalNewline = false
    const c = body[i]!
    if (c === '\\') {
      const e = body[i + 1] ?? ''
      i += 2
      if ('sSDW'.includes(e)) crosses = true // these can match a newline
      if (e === 'n') {
        crosses = true
        literalNewline = true
      }
    } else if (c === '[') {
      let j = i + 1
      if (body[j] === '^') j += 1
      if (body[j] === ']') j += 1
      while (j < body.length && body[j] !== ']') j += body[j] === '\\' ? 2 : 1
      const cls = body.slice(i, j + 1)
      i = j + 1
      const names = /\\[nsSDW]|\n/.test(cls) // the class explicitly names a newline or a class that includes it
      crosses = cls[1] === '^' ? !names : names
    } else if (c === '.') {
      i += 1
      crosses = flags.includes('s')
    } else if (c === '|' || c === '(' || c === ')') {
      return null
    } else {
      i += 1
    }
    let unbounded = false
    let optional = false
    const q = body[i]
    if (q === '*' || q === '+') {
      unbounded = true
      optional = q === '*'
      i += 1
      if (body[i] === '?') i += 1 // lazy
    } else if (q === '?') {
      optional = true
      i += 1
    } else if (q === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(body.slice(i))
      if (m) {
        i += m[0].length
        unbounded = m[2] !== undefined && m[3] === ''
        optional = m[1] === '0'
      }
    }
    out.push({ crosses, unbounded, optional, literalNewline })
  }
  return out
}

/**
 * A repeated group whose every iteration MUST end in a literal newline, and whose inner
 * unbounded quantifiers cannot match a newline, is unambiguous (each iteration is confined to
 * one line), so it backtracks linearly: `(?:DEBUG[^\n]*\n)+`.
 */
function isLineGroup(body: string, flags: string): boolean {
  const atoms = atomsOf(body, flags)
  if (!atoms || atoms.length === 0) return false
  const last = atoms[atoms.length - 1]!
  if (!last.literalNewline || last.optional || last.unbounded) return false
  return atoms.every((a) => !(a.unbounded && a.crosses))
}

/**
 * Heuristic for the classic catastrophic-backtracking shape: a group that already contains an
 * unbounded quantifier, itself quantified — (a+)+, (.*)*, (\w+\s?)*. Not a proof of safety
 * (nothing short of a linear-time engine is), but it rejects the patterns that actually freeze a
 * thread in practice, while accepting the common line-block shape (see isLineGroup).
 */
/** Split a group body at its top-level `|` (ignoring escapes and character classes). */
function alternativesOf(body: string): string[] {
  const alts: string[] = []
  let cur = ''
  let inClass = false
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c === '\\') {
      cur += c + (body[i + 1] ?? '')
      i += 1
    } else if (inClass) {
      if (c === ']') inClass = false
      cur += c
    } else if (c === '[') {
      inClass = true
      cur += c
    } else if (c === '|') {
      alts.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  alts.push(cur)
  return alts
}

/** Alternation under an unbounded repeat is safe only if no two alternatives can start the same way. */
function distinctLiteralStarts(body: string, flags: string): boolean {
  const seen = new Set<string>()
  for (const alt of alternativesOf(body)) {
    let first = alt[0]
    if (first === undefined) return false // an empty alternative
    if (first === '\\') {
      const e = alt[1] ?? ''
      if (e === '' || /[dDwWsSbB0-9]/.test(e)) return false // a class, not a literal
      first = e
    } else if ('[.*+?{'.includes(first)) {
      return false
    }
    if (flags.includes('i')) first = first.toLowerCase()
    if (seen.has(first)) return false
    seen.add(first)
  }
  return true
}

export function looksCatastrophic(pattern: string, flags = ''): boolean {
  const re = /\((?:\?:)?((?:[^()\\]|\\.)*)\)\s*(?:[+*]|\{\d+,\d*\})/g
  for (let m = re.exec(pattern); m !== null; m = re.exec(pattern)) {
    const body = m[1] ?? ''
    const innerQuantified = /[+*]|\{\d+,\d*\}/.test(body.replace(/\\./g, ''))
    if (innerQuantified && !isLineGroup(body, flags)) return true
    // overlapping alternatives under a repeat: (a|aa)+ is exponential
    if (alternativesOf(body).length > 1 && !distinctLiteralStarts(body, flags)) return true
  }
  return false
}

export type Validated =
  | { ok: true; request: TrimRequest; force: boolean; expectedRequests?: number }
  | { ok: false; error: string }

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

function modeOf(v: unknown, where: string): TrimMode | string {
  if (v === undefined) return 'stub'
  if (typeof v !== 'string' || !MODES.includes(v)) {
    return `${where}: mode must be "stub", "summary" or "delete".`
  }
  return v as TrimMode
}

/**
 * Validate everything that can be checked without the transcript: shapes, limits,
 * regex syntax (compiled here, immediately), summary text. Returns an error
 * string for the model to read, or the normalised request.
 */
export function validateTrimParams(params: unknown): Validated {
  if (!isRecord(params)) return fail('trim_session arguments must be an object.')
  const rawTargets = params['tool_targets']
  const rawRules = params['regex_rules']
  if (rawTargets !== undefined && !Array.isArray(rawTargets)) return fail('tool_targets must be an array.')
  if (rawRules !== undefined && !Array.isArray(rawRules)) return fail('regex_rules must be an array.')
  const tt = (rawTargets ?? []) as unknown[]
  const rr = (rawRules ?? []) as unknown[]
  if (tt.length === 0 && rr.length === 0) {
    return fail('Nothing to trim: pass tool_targets and/or regex_rules (use inspect_session to find tool_use_ids).')
  }
  if (tt.length > LIMITS.maxTargets) return fail(`Too many tool_targets (max ${LIMITS.maxTargets}).`)
  if (rr.length > LIMITS.maxRules) return fail(`Too many regex_rules (max ${LIMITS.maxRules}).`)

  const targets: Target[] = []
  const seen = new Set<string>()
  for (let i = 0; i < tt.length; i++) {
    const t = tt[i]
    const where = `tool_targets[${i}]`
    if (!isRecord(t) || typeof t['id'] !== 'string') return fail(`${where}: "id" (a tool_use_id string) is required.`)
    const id = t['id'].trim()
    if (!ID_RE.test(id)) return fail(`${where}: "${id}" does not look like a tool_use_id (e.g. toolu_01ABC…). Copy it from inspect_session.`)
    if (seen.has(id)) return fail(`${where}: duplicate id ${id}.`)
    seen.add(id)
    const mode = modeOf(t['mode'], where)
    if (!MODES.includes(mode)) return fail(mode)
    const replacement = typeof t['replacement'] === 'string' ? t['replacement'].trim() : undefined
    if (mode === 'summary' && !replacement) {
      return fail(`${where}: mode "summary" requires a non-empty "replacement" (a 1–2 sentence takeaway).`)
    }
    if (replacement && replacement.length > LIMITS.maxReplacementChars) {
      return fail(`${where}: replacement is ${replacement.length} chars (max ${LIMITS.maxReplacementChars}); a summary should be 1–2 sentences.`)
    }
    targets.push({ id, mode: mode as TrimMode, ...(mode === 'summary' ? { replacement } : {}) })
  }

  const rules: Rule[] = []
  for (let i = 0; i < rr.length; i++) {
    const r = rr[i]
    const where = `regex_rules[${i}]`
    if (!isRecord(r) || typeof r['pattern'] !== 'string' || r['pattern'] === '') {
      return fail(`${where}: "pattern" (a non-empty string) is required.`)
    }
    const pattern = r['pattern']
    if (pattern.length > LIMITS.maxPatternChars) return fail(`${where}: pattern is longer than ${LIMITS.maxPatternChars} chars.`)
    const flagsIn = r['flags']
    if (flagsIn !== undefined && typeof flagsIn !== 'string') return fail(`${where}: flags must be a string.`)
    const bad = [...(flagsIn ?? '')].filter((c) => !'gimsu'.includes(c))
    if (bad.length > 0) return fail(`${where}: unsupported flag(s) "${bad.join('')}". Allowed: i m s u (g is always on).`)
    const flags = normalizeFlags(flagsIn)
    try {
      const re = compileRule(pattern, flags)
      if (new RegExp(re.source, re.flags.replace('g', '')).test('')) {
        return fail(`${where}: pattern matches the empty string; make it match something specific.`)
      }
    } catch (err) {
      return fail(`${where}: invalid regular expression — ${err instanceof Error ? err.message : String(err)}`)
    }
    if (looksCatastrophic(pattern, flags)) {
      return fail(`${where}: pattern has a nested quantifier (e.g. (a+)+) that can hang the process; rewrite it without nesting.`)
    }
    const mode = modeOf(r['mode'], where)
    if (!MODES.includes(mode)) return fail(mode)
    const replacement = typeof r['replacement'] === 'string' ? r['replacement'].trim() : undefined
    if (mode === 'summary' && !replacement) return fail(`${where}: mode "summary" requires a non-empty "replacement".`)
    if (replacement && replacement.length > LIMITS.maxReplacementChars) return fail(`${where}: replacement too long (max ${LIMITS.maxReplacementChars}).`)

    let scopeToolIds: string[] | undefined
    if (r['scope_tool_ids'] !== undefined) {
      const ids = r['scope_tool_ids']
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > LIMITS.maxScopeIds || !ids.every((x) => typeof x === 'string' && ID_RE.test(x))) {
        return fail(`${where}: scope_tool_ids must be a non-empty array of tool_use_id strings.`)
      }
      scopeToolIds = ids as string[]
    }
    let scopeRoles: Role[] | undefined
    if (r['scope_roles'] !== undefined) {
      const roles = r['scope_roles']
      if (!Array.isArray(roles) || roles.length === 0 || !roles.every((x) => typeof x === 'string' && ROLES.includes(x))) {
        return fail(`${where}: scope_roles must be a non-empty array of "user" and/or "assistant".`)
      }
      scopeRoles = [...new Set(roles as Role[])]
    }
    rules.push({
      pattern,
      flags,
      mode: mode as TrimMode,
      ...(mode === 'summary' ? { replacement } : {}),
      ...(scopeToolIds ? { scopeToolIds } : {}),
      ...(scopeRoles ? { scopeRoles } : {}),
    })
  }

  let note = DEFAULT_NOTE
  if (params['session_note'] !== undefined) {
    if (typeof params['session_note'] !== 'string') return fail('session_note must be a string.')
    const n = params['session_note'].trim()
    if (n.length > LIMITS.maxNoteChars) return fail(`session_note is too long (max ${LIMITS.maxNoteChars} chars).`)
    if (n) note = n
  }

  let expectedRequests: number | undefined
  const er = params['expected_remaining_requests']
  if (er !== undefined) {
    if (typeof er !== 'number' || !Number.isFinite(er) || er < 1 || er > 500) {
      return fail('expected_remaining_requests must be a number between 1 and 500.')
    }
    expectedRequests = Math.round(er)
  }

  return {
    ok: true,
    request: { targets, rules, note },
    force: params['force'] === true,
    ...(expectedRequests !== undefined ? { expectedRequests } : {}),
  }
}
