import { fmtTok, oneLine } from './format.ts'
import { OWN_TOOL_PREFIX } from './inspect.ts'
import type { Analysis } from './inspect.ts'
import type { Role } from './types.ts'

/*
 * Redundancy detection: which older context is made redundant by a NEWER copy?  Pure and deterministic
 * (no `$`, no Node, no crypto): it only decides WHAT looks redundant. Whether and when anything is
 * trimmed stays with the economics (economics.ts) and the flags machinery (flags.ts / register.ts).
 *
 * Principles
 *  - The newer copy wins; the older one is what gets flagged. Never the other way round.
 *  - A missed duplicate costs tokens, a wrong one costs trust: when unsure, do not auto-flag. Unsure but
 *    big matches become `review` findings (told to the agent once; it decides).
 *  - Similarity is measured on CONTENT (normalised, de-numbered lines), not on paths or ids, so it also
 *    finds a re-run command, an edited file read again, or the same text arriving through another tool.
 *  - Tolerance: how much of the OLD text the newer one must still contain is lower for the same source
 *    (same tool + same file/command: edits are expected, the old copy is stale anyway) than across
 *    different sources (sibling files share a lot without being copies).
 *  - Section level: a body is cut at its delimiters (markdown headers, rules, diff headers, tags; else
 *    blank-line blocks). Each section is matched on its own against the newer text as a SET of lines, so
 *    reordered sections still match; adjacent matching sections are merged into one span.
 */

export interface RedundancyConfig {
  /** Share of the OLD content a newer result must contain, for different sources. */
  similarity: number
  /** Same, for the same source (same tool, same file / command / pattern): a newer version replaces the old one. */
  sameSourceSimilarity: number
  /**
   * Same source, but for a SECTION of the old body. Stricter than the whole-body bar: replacing a whole
   * stale version is "the new one wins", replacing part of a body claims that part is a verbatim copy.
   */
  sameSourceSectionSimilarity: number
  /** Bodies smaller than this are never considered. */
  minDocChars: number
  /** A matching span smaller than this is not worth a rule. */
  minSectionChars: number
  /** `review` findings must share at least this many tokens. */
  reviewTokens: number
  /** ... and the newer copy must contain at least this share of the old one. */
  reviewCoverage: number
  charsPerToken: number
  /** Bounds, so a huge history can never make the scan slow. */
  maxDocs: number
  maxTotalChars: number
  maxDocChars: number
}

export const DEFAULT_REDUNDANCY: RedundancyConfig = {
  similarity: 0.95,
  sameSourceSimilarity: 0.6,
  sameSourceSectionSimilarity: 0.85,
  minDocChars: 3000,
  minSectionChars: 1500,
  reviewTokens: 3000,
  reviewCoverage: 0.4,
  charsPerToken: 3.5,
  maxDocs: 300,
  maxTotalChars: 3_000_000,
  maxDocChars: 400_000,
}

export function redundancyConfig(similarity: number | undefined, charsPerToken: number): RedundancyConfig {
  const sim = similarity !== undefined && Number.isFinite(similarity) ? Math.min(1, Math.max(0.5, similarity)) : DEFAULT_REDUNDANCY.similarity
  return { ...DEFAULT_REDUNDANCY, similarity: sim, sameSourceSimilarity: Math.max(0.5, sim - 0.35), sameSourceSectionSimilarity: Math.max(0.5, sim - 0.1), charsPerToken }
}

export interface DocInput {
  id: string
  kind: 'tool' | 'text'
  /** Position in the conversation; a larger order is newer. */
  order: number
  label: string
  text: string
  /** Same value = same source (e.g. `Read\0/src/a.ts`). Absent: never the same source as anything. */
  sourceKey?: string
  role?: Role
  /** May the harness flag it without asking the agent? (Tool results only: a flag can be pinned to a result id.) */
  autoSafe: boolean
}

export interface Span {
  startLine: number
  endLine: number
  /** Exact text of the old copy's lines startLine..endLine joined by \n (no outer blank lines). */
  text: string
  lines: number
  chars: number
  /** First line of the section when it opens with a header/delimiter. */
  header?: string
}

export type FindingKind = 'duplicate' | 'superseded' | 'section'

export interface Finding {
  kind: FindingKind
  /** auto: safe to flag without asking. review: big, but not sure: tell the agent, once. */
  confidence: 'auto' | 'review'
  oldId: string
  newId: string
  oldKind: 'tool' | 'text'
  oldLabel: string
  newLabel: string
  sameSource: boolean
  /** Share of the old copy (whole) or of the spans (section) found in the newer one, 0..1. */
  coverage: number
  /** Characters that disappear if the old copy / the spans are replaced by a short pointer. */
  savedChars: number
  spans?: Span[]
}

// ── hashing and normalising ───────────────────────────────────────────────────

function fnv(s: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

/** 53 bits from two FNV-1a runs: collisions are not a practical concern for a few thousand lines. */
function lineHash(s: string): number {
  return fnv(s, 2166136261) * 0x200000 + (fnv(s, 0x9747b28c) & 0x1fffff)
}

/** `Read` prefixes every line with its number (`12<TAB>` or `  12→`): drop it so shifted lines still match. */
const NUMBER_PREFIX = /^\s*\d+[\t→]/

export function normLine(raw: string): string {
  return raw.replace(NUMBER_PREFIX, '').replace(/\s+/g, ' ').trim()
}

function isSignificant(n: string): boolean {
  return n.length >= 4 && /[\p{L}\p{N}]{3}/u.test(n)
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── sections ───────────────────────────────────────────────────────────────────

/** Lines that open a new section. */
const DELIMITERS: readonly RegExp[] = [
  /^#{1,6}\s+\S/, // markdown header
  /^(?:={3,}|-{3,}|\*{3,}|_{3,})\s*$/, // rule / banner
  /^diff --git /,
  /^@@ /,
  /^<(?:system-reminder|file|document|output|result)\b/i,
  /^(?:PASS|FAIL) \S/, // test runner suites
  /^(?:===|---) \S/,
]

const MIN_SEGMENT_CHARS = 700
const MAX_SEGMENT_CHARS = 8000
/** A section needs at least this much distinctive content to be judged on its own. */
const MIN_SEGMENT_WEIGHT = 300
/** A line that appears in this many different results is boilerplate, not evidence of a copy. */
const STOP_DOCS = 6

interface Seg {
  start: number
  end: number
  header?: string
}

export function segmentLines(lines: readonly string[]): Seg[] {
  const n = lines.length
  if (n === 0) return []
  const strong: number[] = []
  for (let i = 0; i < n; i++) if (DELIMITERS.some((re) => re.test(lines[i] as string))) strong.push(i)
  const starts: number[] = [0]
  if (strong.length >= 2) {
    for (const i of strong) if (i > 0) starts.push(i)
  } else {
    for (let i = 1; i < n; i++) if ((lines[i] as string).trim() !== '' && (lines[i - 1] as string).trim() === '') starts.push(i)
  }
  const raw: Seg[] = starts.map((s, k) => ({ start: s, end: (starts[k + 1] ?? n) - 1 }))
  const chars = (a: number, b: number) => {
    let c = 0
    for (let i = a; i <= b; i++) c += (lines[i] as string).length + 1
    return c
  }
  // Merge small sections forward until a section is big enough to be judged; split the huge ones.
  const merged: Seg[] = []
  let cur: Seg | undefined
  for (const s of raw) {
    cur = cur ? { start: cur.start, end: s.end } : { ...s }
    if (chars(cur.start, cur.end) >= MIN_SEGMENT_CHARS) {
      merged.push(cur)
      cur = undefined
    }
  }
  if (cur) {
    const last = merged[merged.length - 1]
    if (last) last.end = cur.end
    else merged.push(cur)
  }
  const out: Seg[] = []
  for (const s of merged) {
    let a = s.start
    while (a <= s.end) {
      let b = a
      let c = 0
      while (b <= s.end && c < MAX_SEGMENT_CHARS) {
        c += (lines[b] as string).length + 1
        b += 1
      }
      const end = Math.max(a, b - 1)
      const first = lines[a] as string
      out.push({ start: a, end, ...(DELIMITERS.some((re) => re.test(first)) ? { header: first.trim() } : {}) })
      a = end + 1
    }
  }
  return out
}

// ── the scan ──────────────────────────────────────────────────────────────────

interface Prepared {
  d: DocInput
  lines: string[]
  h: number[]
  /** hash -> occurrences, significant lines only. */
  counts: Map<number, number>
  /** Weight of the non-boilerplate content (normalised characters). */
  total: number
}

function prepare(docs: readonly DocInput[], cfg: RedundancyConfig): { items: Prepared[]; weight: Map<number, number>; stop: Set<number> } {
  // newest first, within the bounds; then back to oldest-first
  const newestFirst = [...docs].sort((a, b) => b.order - a.order).slice(0, cfg.maxDocs)
  const picked: DocInput[] = []
  let chars = 0
  for (const d of newestFirst) {
    if (d.text.length < cfg.minDocChars || d.text.length > cfg.maxDocChars) continue
    if (chars + d.text.length > cfg.maxTotalChars) continue
    chars += d.text.length
    picked.push(d)
  }
  picked.sort((a, b) => a.order - b.order)

  const weight = new Map<number, number>()
  const df = new Map<number, number>()
  const items: Prepared[] = picked.map((d) => {
    const lines = d.text.split('\n')
    const h: number[] = new Array<number>(lines.length).fill(0)
    const counts = new Map<number, number>()
    for (let i = 0; i < lines.length; i++) {
      const n = normLine(lines[i] as string)
      if (!isSignificant(n)) continue
      const x = lineHash(n)
      h[i] = x
      weight.set(x, n.length)
      counts.set(x, (counts.get(x) ?? 0) + 1)
    }
    for (const x of counts.keys()) df.set(x, (df.get(x) ?? 0) + 1)
    return { d, lines, h, counts, total: 0 }
  })
  const stop = new Set<number>()
  for (const [x, n] of df) if (n >= STOP_DOCS) stop.add(x)
  for (const p of items) {
    let t = 0
    for (const [x, c] of p.counts) if (!stop.has(x)) t += (weight.get(x) as number) * c
    p.total = t
  }
  return { items, weight, stop }
}

function trimBlank(lines: readonly string[], a: number, b: number): [number, number] {
  let s = a
  let e = b
  while (s <= e && (lines[s] as string).trim() === '') s += 1
  while (e >= s && (lines[e] as string).trim() === '') e -= 1
  return [s, e]
}

/** A segment that is only PARTLY covered is bisected, so an overlap that starts mid-section (a ranged read) is still found. */
const BISECT_MIN_COVERAGE = 0.3
const BISECT_MAX_DEPTH = 5

/** Where to cut a segment in two: at a blank line near the middle if there is one, else in the middle. */
function bisectAt(lines: readonly string[], s: Seg): number {
  const mid = Math.floor((s.start + s.end) / 2)
  for (let d = 0; d <= 15; d++) {
    for (const j of [mid - d, mid + d]) if (j > s.start && j < s.end && (lines[j] as string).trim() === '') return j
  }
  return mid
}

/** The older copy's sections that the newer one still contains (set containment per section, in any order). */
function matchingSpans(old: Prepared, neu: Prepared, segs: readonly Seg[], taken: boolean[], threshold: number, weight: Map<number, number>, stop: Set<number>, cfg: RedundancyConfig): { spans: Span[]; weightSaved: number } {
  const remaining = new Map(neu.counts)
  const hits: Seg[] = []
  const test = (s: Seg, depth: number): void => {
    for (let i = s.start; i <= s.end; i++) if (taken[i]) return
    let segW = 0
    let matched = 0
    // Tentative use of the newer copy's lines: only a section that qualifies actually consumes them,
    // so an earlier section that does not match cannot starve a later one that does.
    const used = new Map<number, number>()
    let chars = 0
    for (let i = s.start; i <= s.end; i++) {
      chars += (old.lines[i] as string).length + 1
      const x = old.h[i] as number
      if (x === 0 || stop.has(x)) continue
      const w = weight.get(x) as number
      segW += w
      const left = (remaining.get(x) ?? 0) - (used.get(x) ?? 0)
      if (left > 0) {
        matched += w
        used.set(x, (used.get(x) ?? 0) + 1)
      }
    }
    if (segW >= MIN_SEGMENT_WEIGHT && matched / segW >= threshold) {
      hits.push(s)
      for (const [x, n] of used) remaining.set(x, (remaining.get(x) ?? 0) - n)
    } else if (depth < BISECT_MAX_DEPTH && segW > 0 && matched / segW >= BISECT_MIN_COVERAGE && chars >= 2 * MIN_SEGMENT_CHARS) {
      const j = bisectAt(old.lines, s)
      test({ start: s.start, end: j }, depth + 1)
      test({ start: j + 1, end: s.end }, depth + 1)
    }
  }
  for (const s of segs) test(s, 0)
  hits.sort((x, y) => x.start - y.start)

  const spans: Span[] = []
  let weightSaved = 0
  let k = 0
  while (k < hits.length) {
    let j = k
    while (j + 1 < hits.length && (hits[j + 1] as Seg).start === (hits[j] as Seg).end + 1) j += 1
    const first = hits[k] as Seg
    const last = hits[j] as Seg
    const [a, b] = trimBlank(old.lines, first.start, last.end)
    if (a <= b) {
      const text = old.lines.slice(a, b + 1).join('\n')
      if (text.length >= cfg.minSectionChars) {
        const head = old.lines[a] as string
        spans.push({ startLine: a, endLine: b, text, lines: b - a + 1, chars: text.length, ...(DELIMITERS.some((re) => re.test(head)) ? { header: head.trim() } : {}) })
        for (let i = a; i <= b; i++) {
          taken[i] = true
          const x = old.h[i] as number
          if (x !== 0 && !stop.has(x)) weightSaved += weight.get(x) as number
        }
      }
    }
    k = j + 1
  }
  return { spans, weightSaved }
}

/**
 * Every older body that a newer one makes redundant, whole or in sections. At most one whole-body finding
 * per old body (against the NEWEST body that qualifies), plus section findings for the rest.
 */
export function findRedundancy(docs: readonly DocInput[], cfg: RedundancyConfig = DEFAULT_REDUNDANCY): Finding[] {
  const { items, weight, stop } = prepare(docs, cfg)
  if (items.length < 2) return []

  const postings = new Map<number, Array<[number, number]>>()
  items.forEach((p, i) => {
    for (const [x, c] of p.counts) {
      if (stop.has(x)) continue
      const l = postings.get(x)
      if (l) l.push([i, c])
      else postings.set(x, [[i, c]])
    }
  })

  const findings: Finding[] = []
  const sizeFloorShared = cfg.minSectionChars * 0.6
  for (let i = 0; i < items.length; i++) {
    const old = items[i] as Prepared
    if (old.total < MIN_SEGMENT_WEIGHT) continue
    const shared = new Map<number, number>()
    for (const [x, c] of old.counts) {
      if (stop.has(x)) continue
      const w = weight.get(x) as number
      for (const [j, cj] of postings.get(x) ?? []) {
        if ((items[j] as Prepared).d.order <= old.d.order) continue
        shared.set(j, (shared.get(j) ?? 0) + w * Math.min(c, cj))
      }
    }
    const cands = [...shared]
      .filter(([, sw]) => sw >= sizeFloorShared)
      .map(([j, sw]) => {
        const neu = items[j] as Prepared
        const same = old.d.sourceKey !== undefined && old.d.sourceKey === neu.d.sourceKey
        return { j, sw, cov: sw / old.total, same, neu }
      })
      .sort((a, b) => b.neu.d.order - a.neu.d.order)
    if (cands.length === 0) continue

    const base = { oldId: old.d.id, oldKind: old.d.kind, oldLabel: old.d.label }
    const whole = cands.find((c) => c.cov >= (c.same ? cfg.sameSourceSimilarity : cfg.similarity))
    if (whole) {
      findings.push({
        ...base,
        kind: whole.cov >= 0.999 ? 'duplicate' : 'superseded',
        confidence: old.d.autoSafe ? 'auto' : 'review',
        newId: whole.neu.d.id,
        newLabel: whole.neu.d.label,
        sameSource: whole.same,
        coverage: whole.cov,
        savedChars: old.d.text.length,
      })
      continue
    }

    // Sections: the old body is not a copy as a whole, but parts of it may be.
    const segs = segmentLines(old.lines)
    const taken: boolean[] = old.lines.map(() => false)
    let any = false
    const byShare = [...cands].sort((a, b) => b.sw - a.sw || b.neu.d.order - a.neu.d.order).slice(0, 3)
    for (const c of byShare.sort((a, b) => b.neu.d.order - a.neu.d.order)) {
      const { spans, weightSaved } = matchingSpans(old, c.neu, segs, taken, c.same ? cfg.sameSourceSectionSimilarity : cfg.similarity, weight, stop, cfg)
      if (spans.length === 0) continue
      any = true
      findings.push({
        ...base,
        kind: 'section',
        confidence: old.d.autoSafe ? 'auto' : 'review',
        newId: c.neu.d.id,
        newLabel: c.neu.d.label,
        sameSource: c.same,
        coverage: Math.min(1, weightSaved / old.total),
        savedChars: spans.reduce((n, s) => n + s.chars, 0),
        spans,
      })
    }
    if (any) continue

    // Big overlap, but neither a copy nor a clean section: worth a mention, never an automatic flag.
    const best = [...cands].sort((a, b) => b.cov - a.cov || b.neu.d.order - a.neu.d.order)[0] as (typeof cands)[number]
    if (best.cov >= cfg.reviewCoverage && best.sw / cfg.charsPerToken >= cfg.reviewTokens) {
      findings.push({
        ...base,
        kind: 'superseded',
        confidence: 'review',
        newId: best.neu.d.id,
        newLabel: best.neu.d.label,
        sameSource: best.same,
        coverage: best.cov,
        savedChars: Math.round(best.sw),
      })
    }
  }
  return findings
}

// ── from a session analysis ───────────────────────────────────────────────────

/** The primary thing a tool call is about: its file, command, pattern, url or query. */
export function sourceKeyOf(tool: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined
  for (const k of ['file_path', 'path', 'command', 'pattern', 'url', 'query']) {
    const v = input[k]
    if (typeof v === 'string' && v.length > 0) return `${tool}\u0000${v}`
  }
  return undefined
}

/** Tool results and large message text of an analysed window, as scan input. Never our own tools, errors or trimmed text. */
export function docsFromAnalysis(a: Analysis, cfg: Pick<RedundancyConfig, 'minDocChars'> = DEFAULT_REDUNDANCY): DocInput[] {
  const docs: DocInput[] = []
  const inputOf = new Map<string, Record<string, unknown>>()
  for (const m of a.messages) for (const u of m.toolUses) inputOf.set(u.tool_use_id, u.input)
  const seq = new Map<number, number>()
  const next = (msg: number) => {
    const k = (seq.get(msg) ?? 0) + 1
    seq.set(msg, k)
    return msg * 1000 + k
  }
  for (const b of a.blocks) {
    if (b.kind !== 'tool' || b.id === undefined || b.tool === undefined || b.isError || b.alreadyTrimmed) continue
    if (b.tool.startsWith(OWN_TOOL_PREFIX)) continue
    const body = a.bodyById.get(b.id)
    if (!body || body.text.length < cfg.minDocChars) continue
    const key = sourceKeyOf(b.tool, inputOf.get(b.id))
    docs.push({ id: b.id, kind: 'tool', order: next(body.msg), label: b.label ?? b.tool, text: body.text, autoSafe: true, ...(key ? { sourceKey: key } : {}) })
  }
  a.messages.forEach((m, i) => {
    if (m.text.length < cfg.minDocChars || m.text.startsWith('[Trimmed') || m.text.startsWith('[selective-context-trim]')) return
    docs.push({ id: `text#${i}`, kind: 'text', role: m.role, order: next(i), label: `${m.role} text #${i}`, text: m.text, autoSafe: false })
  })
  return docs
}

// ── wording ───────────────────────────────────────────────────────────────────

/** `Read(/very/long/path/file.ts)` → `Read(…/long/path/file.ts)`: the end of a path is the part that identifies it. */
export function shortLabel(label: string, max: number): string {
  const one = label.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  const m = /^([^(]*)\((.*)\)$/.exec(one)
  if (!m) return oneLine(one, max)
  const head = `${m[1]}(…`
  const keep = Math.max(8, max - head.length - 1)
  return `${head}${(m[2] as string).slice(-keep)})`
}

export function findingTokens(f: Finding, charsPerToken: number): number {
  return Math.round(f.savedChars / charsPerToken)
}

/** The pointer that replaces a whole old body. */
export function pointerFor(f: Finding): string {
  return f.kind === 'duplicate'
    ? `identical to newer ${shortLabel(f.newLabel, 56)} (${f.newId})`
    : `superseded by newer ${shortLabel(f.newLabel, 56)} (${f.newId}), which holds the current content`
}

/** The pointer that replaces one span of an old body. */
export function spanPointerFor(f: Finding, s: Span): string {
  const where = s.header ? ` ("${oneLine(s.header, 32)}")` : ''
  return `${s.lines} duplicate lines${where} kept in newer ${shortLabel(f.newLabel, 48)} (${f.newId})`
}

export function describeFinding(f: Finding, charsPerToken: number): string {
  const kind = f.kind === 'section' ? `${f.spans?.length ?? 0} section(s)` : f.kind
  return `${f.oldId} (${shortLabel(f.oldLabel, 44)}) ${kind} ≈${fmtTok(findingTokens(f, charsPerToken))} tok ← ${f.newId} (${shortLabel(f.newLabel, 44)}), ${Math.round(f.coverage * 100)}% shared${f.sameSource ? ', same source' : ''}`
}

/** The "redundant older copies" part of inspect_session; empty when there is nothing to say. */
export function redundancyLines(findings: readonly Finding[], flaggedOld: ReadonlySet<string>, charsPerToken: number, max = 6): string {
  if (findings.length === 0) return ''
  const rows = [...findings].sort((a, b) => b.savedChars - a.savedChars).slice(0, max)
  const lines = rows.map((f) => {
    const mark = flaggedOld.has(f.oldId) ? '✓ flagged automatically' : f.confidence === 'auto' ? '○ not flagged (auto-flagging off or cancelled)' : '? worth a look: flag the older one if it is stale'
    return `  ${describeFinding(f, charsPerToken)} — ${mark}`
  })
  const more = findings.length > rows.length ? `\n  … ${findings.length - rows.length} more` : ''
  return `Redundant older copies (the newer result wins; ✓ are pending flags, cancel with unflag):\n${lines.join('\n')}${more}`
}
