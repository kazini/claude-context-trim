/**
 * A stand-in for the Claude Code mod engine, faithful where it matters to this plugin:
 *  - $.fs enforces the real 4 MiB limit per read/write and supports byte ranges;
 *  - the "engine memory" is rebuilt from the JSONL file on /resume (so a rewritten
 *    transcript is only visible after a reload), and a resume can succeed, no-op,
 *    throw, hang, or fail depending on the file's content;
 *  - time is virtual: sleep/after only advance inside settle().
 */
import { register } from '../../selective-context-trim/hooks/register.ts'
import { QUEUED, TRIM_TOOL, Transcript } from './fixtures.ts'
import type { Msg, MsgToolUse } from '../../selective-context-trim/hooks/lib/types.ts'

type Json = Record<string, any>
type Handler = { event: string; matcher?: Json; fn: (...a: any[]) => any; catchFn?: (...a: any[]) => any }

export const MiB = 1024 * 1024
export const SESSION = 'sess-1'
export const PATH = '/home/u/.claude/projects/-repo/sess-1.jsonl'
export const BACKUP = PATH + '_trim-backup'

export type ResumeMode = 'ok' | 'noop' | 'throw' | 'hang' | 'notfound'

export function rowsToMessages(rows: Json[]): Msg[] {
  const out: (Msg & { _mid?: string })[] = []
  const uses = new Map<string, MsgToolUse>()
  for (const r of rows) {
    const msg = r['message']
    if (!msg || (r['type'] !== 'user' && r['type'] !== 'assistant')) continue
    const content = msg['content']
    if (r['type'] === 'assistant') {
      let m = out[out.length - 1]
      if (!(m && m.role === 'assistant' && m._mid === msg['id'])) {
        m = { role: 'assistant', text: '', toolUses: [], _mid: msg['id'], uuid: r['uuid'] }
        out.push(m)
      }
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'text') m.text += (m.text ? '\n' : '') + b.text
        else if (b.type === 'tool_use') {
          const u: MsgToolUse = { tool_use_id: b.id, tool: b.name, input: b.input }
          m.toolUses.push(u)
          uses.set(b.id, u)
        }
      }
    } else if (typeof content === 'string') {
      out.push({ role: 'user', text: content, toolUses: [] })
    } else {
      const m: Msg = { role: 'user', text: '', toolUses: [], toolResults: [] }
      for (const b of content ?? []) {
        if (b.type === 'text') m.text += b.text
        if (b.type === 'tool_result') {
          const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((p: Json) => p.text ?? '').join('\n')
          m.toolResults!.push({ tool_use_id: b.tool_use_id, text, ...(b.is_error ? { isError: true } : {}) })
          const u = uses.get(b.tool_use_id)
          if (u) u.text = text
        }
      }
      out.push(m)
    }
  }
  return out
}

export class FakeEngine {
  files = new Map<string, string>()
  now = 1_000_000
  private timers: { at: number; fn: () => void; id: number }[] = []
  private nextTimer = 1
  private handlers: Handler[] = []
  private stepHandlers: Handler[] = []
  tools = new Map<string, Json>()
  commands: string[] = []
  commandRuns: string[] = []
  prompts: string[] = []
  logs: string[] = []
  toasts: string[] = []
  asked: string[] = []
  askAnswer = 'Trim anyway'
  store = new Map<string, unknown>()
  processRuns: string[][] = []
  /** File modes, as a real filesystem would keep them (fresh writes are 644). */
  modes = new Map<string, string>()
  sessionId = SESSION
  platform = 'linux'
  /** Newer builds accept $.session.messages({ last }); 2.1.318 does not. */
  rangedMessages = false
  /** Does the engine's classic SessionStart/UserPromptSubmit event carry transcript_path? */
  reportTranscript = true
  env: Record<string, string | undefined> = { HOME: '/home/u' }
  cwd = '/repo'
  model = 'claude-sonnet-5-5'
  contextTokens = 70_000
  window = 200_000
  percent = 35
  memory: Json[] = []
  /** What the next resume does; may depend on the attempt number and the file's current text. */
  resumeMode: (attempt: number, file: string) => ResumeMode = () => 'ok'
  private resumeAttempts = 0
  /** A resume of the file fails (throws) when this returns true for its text. */
  failResumeIf: (text: string) => boolean = () => false
  /** Rows to append only after a delay (a slow flush), as [ms, rows]. */
  readonly $: Json

  constructor(options: Json = {}) {
    this.$ = this.buildApi()
    register(((event: string, a: any, b?: any) => {
      const h: Handler = typeof a === 'function' ? { event, fn: a } : { event, matcher: a, fn: b }
      ;(event === 'turn.step' ? this.stepHandlers : this.handlers).push(h)
      // on(...) returns a builder whose .catch(handler) answers when the hook throws
      return { catch: (fn: (...a: any[]) => any) => void (h.catchFn = fn) }
    }) as any, options as any)
  }

  // ── files ──────────────────────────────────────────────────────────────────
  write(path: string, text: string): void {
    this.files.set(path, text)
  }
  text(path: string): string {
    const t = this.files.get(path)
    if (t === undefined) throw new Error('no such file ' + path)
    return t
  }
  rows(path = PATH): Json[] {
    return this.text(path)
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  }
  lines(path = PATH): string[] {
    return this.text(path).split('\n').filter(Boolean)
  }

  /** Put a transcript on disk and load it into "memory", as the engine would on startup. */
  load(t: Transcript | string): void {
    this.files.set(PATH, typeof t === 'string' ? t : t.file())
    this.modes.set(PATH, '600') // Claude Code writes its transcripts 0600
    this.reloadMemory()
  }
  reloadMemory(): void {
    this.memory = this.lines().map((l) => JSON.parse(l))
  }
  /** The engine appends rows to its transcript (and memory) as it works. */
  append(t: Transcript): void {
    const text = t.lines().join('\n') + '\n'
    this.files.set(PATH, (this.files.get(PATH) ?? '') + text)
    for (const l of t.lines()) this.memory.push(JSON.parse(l))
  }

  // ── time ───────────────────────────────────────────────────────────────────
  private after(ms: number, fn: () => void) {
    const id = this.nextTimer++
    this.timers.push({ at: this.now + ms, fn, id })
    return { cancel: () => (this.timers = this.timers.filter((t) => t.id !== id)) }
  }

  /** Run everything that is runnable, advancing virtual time to the next timer, up to `maxMs`. */
  async settle(maxMs = 120_000): Promise<void> {
    const until = this.now + maxMs
    for (let guard = 0; guard < 20_000; guard++) {
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      const next = this.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!next) return
      this.timers = this.timers.filter((t) => t !== next)
      this.now = Math.max(this.now, next.at)
      next.fn()
    }
    throw new Error('settle(): did not quiesce (infinite loop?)')
  }
  get pendingTimers(): number {
    return this.timers.length
  }

  // ── events ─────────────────────────────────────────────────────────────────
  async emit(event: string, input: Json = {}): Promise<any> {
    const hs = this.handlers.filter((h) => h.event === event && (!h.matcher || Object.entries(h.matcher).every(([k, v]) => input[k] === v)))
    const run = async (i: number, e: Json): Promise<any> => {
      if (i >= hs.length) return undefined
      const h = hs[i]!
      const next: any = (ne: Json) => {
        next.called = true
        return run(i + 1, ne)
      }
      next.called = false
      try {
        return await h.fn(this.$, e, next)
      } catch (err) {
        if (!h.catchFn) return run(i + 1, e) // a throwing hook is skipped
        const nx: any = (ne: Json) => run(i + 1, ne)
        nx.called = next.called
        nx.error = err
        return h.catchFn(this.$, e, nx)
      }
    }
    return run(0, input)
  }

  /** A model request: runs the turn.step stream hook around a fake response. */
  async step(opts: { agentId?: string; usage?: Json | null } = {}): Promise<void> {
    const e = { turnId: 't', index: 0, ...(opts.agentId ? { agentId: opts.agentId } : {}) }
    const terminal = async function* () {
      return { usage: opts.usage ?? null }
    }
    const h = this.stepHandlers[0]
    if (!h) return
    const gen = h.fn(this.$, e, () => terminal())
    for (;;) {
      const r = await gen.next()
      if (r.done) return
    }
  }

  async start(): Promise<void> {
    await this.emit('session.start', {})
    if (this.reportTranscript) await this.classic('SessionStart', { source: 'startup' })
  }

  /** A classic (settings-hook) event: base fields carry the session id and transcript path. */
  async classic(name: string, extra: Json = {}): Promise<any> {
    return this.emit(`classic.${name}`, { session_id: this.sessionId, transcript_path: PATH, cwd: this.cwd, ...extra })
  }

  /** The model calls a tool; returns what the hook answered. */
  async callTool(name: string, args: Json, id = 'toolu_call1'): Promise<any> {
    return this.emit('tool.call', { tool: `mcp__selective-context-trim__${name}`, tool_use_id: id, ...args })
  }

  /**
   * End the turn in which trim_session was called: the engine flushes the tool_use,
   * its result and a closing sentence to the transcript, then fires turn.complete.
   */
  async endTrimTurn(id: string, args: Json, result = QUEUED, opts: { reason?: string; flushDelayMs?: number } = {}): Promise<void> {
    const t = new Transcript(SESSION)
    // continue the chain from whatever is already on disk
    const rows = this.rows()
    const lastUuid = [...rows].reverse().find((r) => typeof r['uuid'] === 'string')?.['uuid'] ?? null
    ;(t as any).last = lastUuid
    ;(t as any).n = 1000 + rows.length
    t.toolUse('m_trim', id, TRIM_TOOL, args).toolResult(id, result).text('m_trim_end', 'Trim queued.')
    const flush = () => this.append(t)
    if (opts.flushDelayMs) this.after(opts.flushDelayMs, flush)
    else flush()
    await this.emit('turn.complete', { reason: opts.reason ?? 'answer', ...(opts as Json) })
  }

  /** The user hits enter. */
  async userPrompt(text: string): Promise<any> {
    return this.emit('prompt.submit', { text })
  }

  // ── $ ────────────────────────────────────────────────────────────────────────
  private buildApi(): Json {
    const self = this
    const bytes = (s: string) => Buffer.from(s, 'utf8')
    const need = (p: string) => {
      const t = self.files.get(p)
      if (t === undefined) throw new Error(`ENOENT ${p}`)
      return t
    }
    return {
      tool: {
        register: async (spec: Json) => {
          self.tools.set(spec['name'], spec)
        },
      },
      command: {
        register: async (spec: Json) => {
          self.commands.push(spec['name'])
        },
        run: async ({ command, args }: { command: string; args: string }) => {
          self.commandRuns.push(`${command}${args ? ' ' + args : ''}`)
          if (command === 'clear') {
            self.memory = []
            self.sessionId = 'sess-new'
            await self.emit('session.end', { reason: 'clear' })
            return { text: '' }
          }
          if (command === 'resume') {
            const attempt = ++self.resumeAttempts
            const mode = self.resumeMode(attempt, self.files.get(PATH) ?? '')
            if (mode === 'hang') return new Promise(() => undefined)
            if (mode === 'throw') throw new Error('resume failed')
            if (mode === 'noop' && args === self.sessionId) return { text: 'already in this session' }
            if (mode === 'notfound') return { text: 'No conversations found to resume.' } // an error reported as text
            const text = need(PATH)
            if (self.failResumeIf(text)) throw new Error('could not load transcript')
            await self.emit('session.end', { reason: 'resume' })
            self.sessionId = args
            self.reloadMemory()
            return { text: '' }
          }
          return { text: '' }
        },
      },
      session: {
        id: async () => self.sessionId,
        model: async () => self.model,
        // 2.1.318 has no $.session.info
        cwd: async () => self.cwd,
        root: async () => self.cwd,
        usage: async () => ({
          startedAt: 0,
          context: { tokens: self.contextTokens, window: self.window, percent: self.percent, breakdown: { apiUsage: null } },
        }),
        // Claude Code 2.1.318 rejects ranged reads; so does this fake unless a test opts in.
        messages: async (args: { last?: number } = {}) => {
          if (args.last !== undefined && !self.rangedMessages) {
            throw new Error('HooksError: $.session.messages takes { agentId, as } or nothing (not last)')
          }
          const all = rowsToMessages(self.memory)
          return args.last ? all.slice(-args.last) : all
        },
      },
      fs: {
        // 2.1.318: whole files only (4 MiB); byte ranges are not an option of $.fs.read
        read: async (p: string, o?: Json) => {
          if (o && ('offset' in o || 'length' in o)) throw new Error('HooksError: $.fs.read takes { as } only')
          const b = bytes(need(p))
          if (b.length > 4 * MiB) throw new Error('fs.read: file over 4 MiB')
          return b.toString('utf8')
        },
        write: async (p: string, text: string) => {
          if (bytes(text).length > 4 * MiB) throw new Error('fs.write: over 4 MiB')
          self.files.set(p, text)
        },
        stat: async (p: string) => ({ size: bytes(need(p)).length, mtimeMs: self.now }),
        exists: async (p: string) => self.files.has(p),
      },
      process: {
        run: async (argv: string[]) => {
          self.processRuns.push(argv)
          const ok = { exitCode: 0, stdout: '', stderr: '' }
          const [cmd] = argv
          if (cmd === 'mv') {
            self.files.set(argv[3]!, need(argv[2]!))
            self.files.delete(argv[2]!)
            self.modes.set(argv[3]!, self.modes.get(argv[2]!) ?? '644')
            self.modes.delete(argv[2]!)
          } else if (cmd === 'cp') {
            self.files.set(argv[3]!, need(argv[2]!))
          } else if (cmd === 'chmod') {
            self.modes.set(argv[2]!, argv[1]!)
          } else if (cmd === 'rm') {
            self.files.delete(argv[2]!)
          } else if (cmd === 'tail') {
            // tail -c N path -> stdout is capped at 4 MiB like $.process.run
            const n = Number(argv[2])
            const out = bytes(need(argv[3]!))
            const slice = out.subarray(Math.max(0, out.length - n))
            if (slice.length > 4 * MiB) return { exitCode: 0, stdout: slice.subarray(0, 4 * MiB).toString('utf8'), stderr: '', isStdoutTruncated: true }
            return { exitCode: 0, stdout: slice.toString('utf8'), stderr: '' }
          } else if (cmd === 'sh') {
            const [, , , , n, src, dst, tail] = argv
            self.files.set(dst!, bytes(need(src!)).subarray(0, Number(n)).toString('utf8') + need(tail!))
          } else return { exitCode: 127, stdout: '', stderr: 'unknown command in fake' }
          return ok
        },
      },
      clock: {
        now: async () => self.now,
        sleep: (ms: number) => new Promise<void>((res) => self.after(ms, res)),
        after: (ms: number, fn: () => void) => self.after(ms, fn),
      },
      prompt: {
        submit: (a: { text: string }) => {
          self.prompts.push(a.text)
          return Promise.resolve()
        },
      },
      ui: {
        log: (t: string) => void self.logs.push(t),
        toast: (t: string) => void self.toasts.push(t),
        ask: async (q: string) => {
          self.asked.push(q)
          return self.askAnswer
        },
      },
      env: {
        get: async (k: string) => self.env[k],
      },
      store: {
        get: async (k: string) => self.store.get(k),
        set: async (k: string, v: unknown) => void self.store.set(k, v),
      },
    }
  }
}
