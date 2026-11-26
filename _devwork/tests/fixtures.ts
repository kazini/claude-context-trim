/** Builds transcripts shaped like Claude Code's own: one content block per line, parentUuid chain. */

type Json = Record<string, unknown>

export const TRIM_TOOL = 'mcp__selective-context-trim__trim_session'
export const QUEUED = 'Session trim queued. Finish your response now without calling further tools so the session can reload.'

export class Transcript {
  readonly rows: Json[] = []
  private last: string | null = null
  private n = 0
  readonly sessionId: string

  constructor(sessionId = 'sess-1') {
    this.sessionId = sessionId
  }

  private add(type: 'user' | 'assistant', message: Json, extra: Json = {}): string {
    const uuid = `u${++this.n}`
    this.rows.push({
      parentUuid: this.last,
      isSidechain: false,
      userType: 'external',
      cwd: '/repo',
      sessionId: this.sessionId,
      version: '2.1.327',
      type,
      message,
      uuid,
      timestamp: `2026-11-18T10:00:${String(this.n % 60).padStart(2, '0')}.000Z`,
      ...extra,
    })
    this.last = uuid
    return uuid
  }

  /** Non-message metadata line (no uuid chain participation). */
  meta(obj: Json): this {
    this.rows.push(obj)
    return this
  }

  user(text: string): this {
    this.add('user', { role: 'user', content: text })
    return this
  }

  private asst(msgId: string, block: Json): string {
    return this.add('assistant', { id: msgId, type: 'message', role: 'assistant', model: 'claude-test', content: [block] }, { requestId: `req_${msgId}` })
  }

  thinking(msgId: string, text = 'hmm'): this {
    this.asst(msgId, { type: 'thinking', thinking: text, signature: 'sig-' + text })
    return this
  }

  text(msgId: string, text: string): this {
    this.asst(msgId, { type: 'text', text })
    return this
  }

  toolUse(msgId: string, id: string, name: string, input: Json): this {
    this.asst(msgId, { type: 'tool_use', id, name, input })
    return this
  }

  toolResult(id: string, content: string | Json[], opts: { isError?: boolean } = {}): this {
    const block: Json = { tool_use_id: id, type: 'tool_result', content }
    if (opts.isError) block['is_error'] = true
    this.add('user', { role: 'user', content: [block] }, { toolUseResult: typeof content === 'string' ? { stdout: content } : content })
    return this
  }

  lines(): string[] {
    return this.rows.map((r) => JSON.stringify(r))
  }

  /** The whole file as the engine writes it (newline-terminated). */
  file(): string {
    return this.lines().join('\n') + '\n'
  }
}

export function numberedLines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}: const value${i} = compute(${i})`).join('\n')
}

/**
 * Standard scenario: a Read (142 lines), a noisy Bash, a Grep, then the
 * trim_session call and its "queued" result, then the closing assistant text.
 */
export function scenario(): Transcript {
  const t = new Transcript()
  t.user('fix the auth bug')
  t.thinking('m1', 'plan: read auth first')
  t.text('m1', 'Reading the file.')
  t.toolUse('m1', 'toolu_read1', 'Read', { file_path: 'src/auth.ts' })
  t.toolResult('toolu_read1', numberedLines(142, 'auth'))
  t.thinking('m2', 'now run the tests')
  t.toolUse('m2', 'toolu_bash1', 'Bash', { command: 'npm test' })
  t.toolResult('toolu_bash1', Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? `DEBUG noisy line ${i}` : `ok test ${i}`)).join('\n'))
  t.thinking('m3', 'search usages')
  t.text('m3', 'Found the failing test; searching.')
  t.toolUse('m3', 'toolu_grep1', 'Grep', { pattern: 'verifyToken' })
  t.toolResult('toolu_grep1', numberedLines(25, 'match'))
  t.thinking('m4', 'trim now')
  t.toolUse('m4', 'toolu_trim1', TRIM_TOOL, { tool_targets: [{ id: 'toolu_read1' }] })
  t.toolResult('toolu_trim1', QUEUED)
  t.text('m5', 'Trim queued.')
  return t
}

/** Every parentUuid is null or the uuid of an EARLIER surviving line. */
export function chainProblems(lines: string[]): string[] {
  const seen = new Set<string>()
  const problems: string[] = []
  for (const l of lines) {
    const o = JSON.parse(l) as Json
    if (typeof o['uuid'] !== 'string') continue
    const p = o['parentUuid']
    if (p !== null && p !== undefined && !seen.has(p as string)) problems.push(`${o['uuid']} -> missing parent ${String(p)}`)
    seen.add(o['uuid'])
  }
  return problems
}

/** tool_use ids / tool_result ids still present, for orphan checks. */
export function pairing(lines: string[]): { uses: Set<string>; results: Set<string> } {
  const uses = new Set<string>()
  const results = new Set<string>()
  for (const l of lines) {
    const o = JSON.parse(l) as { message?: { content?: unknown } }
    const c = o.message?.content
    if (!Array.isArray(c)) continue
    for (const b of c as Json[]) {
      if (b['type'] === 'tool_use') uses.add(b['id'] as string)
      if (b['type'] === 'tool_result') results.add(b['tool_use_id'] as string)
    }
  }
  return { uses, results }
}

export function parse(line: string): Json {
  return JSON.parse(line) as Json
}
