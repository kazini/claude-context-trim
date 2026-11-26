import type { EngineInterface, On, PluginOptions } from 'claude-code'

import { adviceFor, DEFAULT_ECON, judge, readMultFor, TTL_MS } from './lib/economics.ts'
import type { CacheState, EconConfig, Verdict } from './lib/economics.ts'
import { byteLength, fmtTok } from './lib/format.ts'
import { analyzeSession, estimatePlan, OWN_TOOL_PREFIX, positionOf, renderInspect } from './lib/inspect.ts'
import type { Analysis, PlanEstimate } from './lib/inspect.ts'
import { applyTrimToTranscript } from './lib/transcript.ts'
import type { Msg, TranscriptResult, TrimReport, TrimRequest, UsageLike } from './lib/types.ts'
import { addFlags, autoCount, autoFlagsFromFindings, deferrable, describeFlags, dropInvalidAuto, flagsFromRequest, flagToolIds, ownToolFlags, removeFlags, requestFromFlags, settledCalls } from './lib/flags.ts'
import type { Flag } from './lib/flags.ts'
import { DEFAULT_REDUNDANCY, describeFinding, docsFromAnalysis, findingTokens, findRedundancy, redundancyConfig, redundancyLines } from './lib/redundancy.ts'
import type { Finding } from './lib/redundancy.ts'
import { DEFAULT_NOTE, validateTrimParams } from './lib/validate.ts'

/*
 * All `$` calls live in this file: `claude plugin validate` only follows `$` into
 * top-level functions of the same module, so the pure logic (hooks/lib) never
 * sees it, and the state below is shared by the hooks like any module variable.
 */

const PLUGIN = 'selective-context-trim'

const QUEUED_TEXT = 'Session trim queued. Finish your response now without calling further tools so the session can reload.'
const QUEUED_MARK = 'Session trim queued'
const FAILURE_TEXT = 'Selective Context Trim failed to resume the trimmed session; reverted to the previous backup (.jsonl_trim-backup).'

const WINDOW_MESSAGES = 400
/** $.fs reads and writes are capped at 4 MiB; stay clear of it. */
const WHOLE_FILE_MAX = 3.5 * 1024 * 1024
const FLUSH_TIMEOUT_MS = 3000
const NOOP_DETECT_MS = 1500
const PHASE_DEADLINE_MS = 45_000

type Phase = 'idle' | 'pending' | 'applying' | 'reloading' | 'rolling-back'
type Strategy = 'direct' | 'clear-resume'

type Source = 'agent' | 'turn-end' | 'cold'

interface VerifyEntry {
  id: string
  mode: 'stub' | 'summary' | 'delete' | 'rule'
  /** Length of the result text before the rewrite (-1: not in the inspected window). */
  before: number
}

interface Cfg extends EconConfig {
  nudges: boolean
  nudgeTokens: number
  autoAllowTools: boolean
  reloadStrategy: 'auto' | Strategy
  resumeTimeoutMs: number
  autoContinue: boolean
  /** Flag older copies that a newer result makes redundant, without being asked. */
  autoFlag: boolean
  /** How much of an older result a newer one must still contain (different sources). */
  similarity: number
}

interface PendingTrimRequest {
  /** agent: the agent asked and expects to continue; turn-end / cold: applied by the harness while idle. */
  source: Source
  /** Prompt the agent to carry on after the reload (only when it is mid-task). */
  continueAfter: boolean
  /** Flags folded into this job (for the notice). */
  flagCount: number
  request: TrimRequest
  /** tool_use ids of every trim_session call of this turn (all are collapsed). */
  trimCallIds: string[]
  /** Earlier trim_session calls whose flags are all resolved: cleared by the same rewrite. */
  settledCallIds: string[]
  /** How many of the folded flags the plugin made itself. */
  autoCount: number
  /** Of those, how many are this plugin's own inspect/trim results (not redundant older copies). */
  ownAutoCount: number
  verdict: Verdict
}

interface AwaitingResumeVerification {
  source: Source
  /** What to look for after a reload when there is no trim_session call to look at. */
  verify: VerifyEntry[]
  sessionId: string
  transcriptPath: string
  backupPath: string
  retries: number
  trimCallIds: string[]
  note: string
  /** `session.end` with reason `resume` has been seen since the reload was dispatched. */
  resumeEndSeen: boolean
  lastError?: string
  /** What the last /resume command printed (the engine reports many failures as text, not as errors). */
  lastText?: string
  /** Bytes the rewrite produced: the file must still be at least this big before anything destructive is tried. */
  expectedSize: number
}

interface Snapshot {
  size: number
  /** Byte offset in the file at which lines[0] begins. */
  start: number
  lines: string[]
  /** True when `lines` is the whole file. */
  whole: boolean
  /** True when the data ends on a newline (no half-written last line). */
  complete: boolean
}

let cfg: Cfg = { ...DEFAULT_ECON, nudges: true, nudgeTokens: 6000, autoAllowTools: true, reloadStrategy: 'auto', resumeTimeoutMs: 5000, autoContinue: true, autoFlag: true, similarity: DEFAULT_REDUNDANCY.similarity }
let phase: Phase = 'idle'
let phaseDeadline = 0
let pendingTrimRequest: PendingTrimRequest | undefined
let awaitingResumeVerification: AwaitingResumeVerification | undefined
let newTurnDuringApply = false
/** When the main thread's prompt cache was last read or written (0 = not observed yet). */
let lastTouchAt = 0
/** Cache lifetime the API's own usage has shown (1h writes seen, else 5m). */
let observedTtl: '5m' | '1h' | undefined
/** The transcript path the engine reported (classic hook events carry it), per session. */
let knownTranscript: { sessionId: string; path: string } | undefined
/** Things the agent has flagged for trimming and that have not paid off yet. */
let flags: Flag[] = []
const flagCounter = { n: 0 }
let turnActive = false
let coldTimer: { cancel(): void } | undefined
/** Told to the agent once, with its next prompt, after the harness trimmed something while it was idle. */
let idleNotice: string | undefined
let toolsSinceNudge = 99
/** trim_session calls that created flags and have not been cleared from the transcript yet. */
let openCallIds = new Set<string>()
/** Older results whose automatic flag the agent cancelled: never flagged again. */
let vetoedAuto = new Set<string>()
/** A large result arrived since the last redundancy scan (it may not be readable from the session yet). */
let scanPending = false
/** The one-time "worth a look" message has been given. */
let reviewNoticeSent = false
const COLD_MARGIN_MS = 3000

// ── model-facing tool descriptions ───────────────────────────────────────────

const INSPECT_DESCRIPTION = `Read-only overview of this conversation's context: the largest recent tool results with their exact tool_use_ids, sizes, how each sits against the prompt cache, which set would pay off right now (★), and your pending flags. Optional: hints after large results already give you ids. Call it when you want the whole picture before flagging; each call costs one request.

Optional: last_messages (default 150), min_tokens (default 500), max_rows (default 20).`

const TRIM_DESCRIPTION = `Flag tool results you are finished with so they can be shrunk out of your context. Flagging is free and safe: nothing is applied until it pays off against the prompt cache, so flag as soon as you have noted what you need — you never have to judge the economics.

AUTOMATIC FLAGS: when a newer result repeats an older one (a file read again after edits, a command re-run, the same text twice), the OLDER copy is flagged for you ("auto" in list) and replaced by a short pointer to the newer one. Older inspect_session and trim_session results are also flagged ("auto: delete this plugin's own result"); the newest one is kept. Cancel any of these with unflag.

WHAT HAPPENS TO A FLAG
- By default everything you flag stays PENDING: the tool says so, and you just carry on. It is applied automatically, with no action from you, when it pays off, when context gets tight, or once the prompt cache has expired (a few minutes of inactivity), because a rewrite then costs nothing. You are told once, with your next prompt, that it happened.
- force: true is the explicit "do it now" for a big change or a replacement you care about. It queues the trim for the end of this turn: end your turn with one short sentence and no more tool calls. The session reloads, you receive a message starting with your session note, and you continue the task. A set that would re-process far more than it saves still waits.

WHEN TO FLAG: a large result (about 5k+ tokens: a whole-file Read, long test/build/log output, a big search dump) that you have extracted what you need from. Skip small results and anything you may need verbatim again; when you are nearly done (the answer is next) there is no point.

BEFORE FLAGGING: write down, in your own visible text, every fact you still need from the result (a stub keeps only metadata), or use mode "summary" with a 1–2 sentence replacement. If you use force: true, call trim_session in a turn by itself (no parallel tool calls).

PARAMETERS
tool_targets: [{ id, mode?, replacement? }] — id is the tool_use_id (shown in the hints after large results and in inspect_session). mode "stub" (default): body becomes "[Trimmed: N lines / M chars removed from Read(file) (id)]"; "summary": body becomes "[Trimmed — Summary: <replacement>]" (replacement required); "delete": removes the tool call and its result entirely.
regex_rules: [{ pattern, flags?, scope_tool_ids, mode?, replacement? }] — JavaScript regex over decoded result text (flags i m s u; g is implied), pinned to results with scope_tool_ids so it can wait safely (an unscoped rule can only be applied immediately; scope_roles limits to "user"/"assistant" text). Same modes: stub "[Trimmed: N lines / M chars matched]", summary, delete. Patterns must not match the empty string. Repeated line groups such as (?:DEBUG[^\\n]*\\n)+ are fine; nested quantifiers such as (a+)+ are refused.
unflag: ["f2", "toolu_…"] — drop flags by flag id or tool_use_id. list: true — show what is pending and why. Re-flagging an id that is already flagged just replaces its mode/replacement; no extra reply is needed.
session_note: text left where this call was (default "Agent pruned context: success"). expected_remaining_requests: how many more model requests you expect (sharpens the pay-off estimate). force: true — the explicit "apply now": queue the trim for the end of this turn even when it does not pay off (one that would re-process far more than it saves still waits). Without force, flags stay pending and the automatic trimmer applies them.`

const STANDING_NOTE =
  '[selective-context-trim] You can free tool results you are finished with: flag them with trim_session (free; it is applied automatically when it pays off or the prompt cache has expired; pass force: true to apply it now). Hints with tool_use_ids follow large results. Older copies that a newer result supersedes, and older results of this plugin\'s own tools, are flagged for you automatically (cancel with unflag).'

const TRIM_SCHEMA = {
  type: 'object',
  properties: {
    tool_targets: {
      type: 'array',
      description: 'Specific tool calls to trim, by tool_use_id (from inspect_session).',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'tool_use_id, e.g. toolu_01AbC…' },
          mode: { type: 'string', enum: ['stub', 'summary', 'delete'], description: 'Default "stub".' },
          replacement: { type: 'string', description: 'Required for mode "summary": a 1–2 sentence takeaway.' },
        },
        required: ['id'],
      },
    },
    regex_rules: {
      type: 'array',
      description: 'Regex rules over decoded result text; pin them with scope_tool_ids so they can wait.',
      items: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          flags: { type: 'string', description: 'Any of i, m, s, u.' },
          scope_tool_ids: { type: 'array', items: { type: 'string' } },
          scope_roles: { type: 'array', items: { type: 'string', enum: ['user', 'assistant'] } },
          mode: { type: 'string', enum: ['stub', 'summary', 'delete'] },
          replacement: { type: 'string', description: 'Required for mode "summary".' },
        },
        required: ['pattern'],
      },
    },
    session_note: { type: 'string', description: 'Default "Agent pruned context: success".' },
    expected_remaining_requests: { type: 'number', description: 'How many more model requests you expect (1–500).' },
    unflag: { type: 'array', items: { type: 'string' }, description: 'Flag ids (f1…) or tool_use_ids to drop from the pending flags.' },
    list: { type: 'boolean', description: 'Show what is pending and why.' },
    force: { type: 'boolean', description: 'Opt out of deferral: queue this trim for the end of the turn now, even if it does not pay off (a very expensive one still waits).' },
  },
}

const INSPECT_SCHEMA = {
  type: 'object',
  properties: {
    last_messages: { type: 'number', description: 'How many recent messages to inspect (default 150, max 1000).' },
    min_tokens: { type: 'number', description: 'Only list results of at least this many tokens (default 500).' },
    max_rows: { type: 'number', description: 'Maximum rows to list (default 20).' },
  },
}

// ── configuration ────────────────────────────────────────────────────────────

function numOpt(v: unknown, d: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d
}

function configOf(options: PluginOptions): Cfg {
  const o = options as Readonly<Record<string, unknown>>
  const strat = o['reloadStrategy']
  return {
    cacheTtl: o['cacheTtl'] === '1h' ? '1h' : o['cacheTtl'] === '5m' ? '5m' : 'auto',
    cacheReadMultiplier: numOpt(o['cacheReadMultiplier'], 0, 0, 1),
    quickRatio: DEFAULT_ECON.quickRatio,
    sizeableTokens: numOpt(o['sizeableTokens'], DEFAULT_ECON.sizeableTokens, 1000, 1_000_000),
    batchMinItems: DEFAULT_ECON.batchMinItems,
    batchMargin: DEFAULT_ECON.batchMargin,
    lookbackBlocks: numOpt(o['lookbackBlocks'], DEFAULT_ECON.lookbackBlocks, 1, 100_000),
    fixedPrefixTokens: DEFAULT_ECON.fixedPrefixTokens,
    assumedRemainingRequests: numOpt(o['assumedRemainingRequests'], DEFAULT_ECON.assumedRemainingRequests, 1, 500),
    overheadRequests: DEFAULT_ECON.overheadRequests,
    minSavingsTokens: numOpt(o['minSavingsTokens'], DEFAULT_ECON.minSavingsTokens, 0, 1_000_000),
    pressurePercent: DEFAULT_ECON.pressurePercent,
    charsPerToken: numOpt(o['charsPerToken'], DEFAULT_ECON.charsPerToken, 2, 6),
    autoAllowTools: o['autoAllowTools'] !== false,
    reloadStrategy: strat === 'direct' || strat === 'clear-resume' ? strat : 'auto',
    resumeTimeoutMs: numOpt(o['resumeTimeoutMs'], 5000, 1000, 60_000),
    autoContinue: o['autoContinue'] !== false,
    nudges: o['nudges'] !== false,
    nudgeTokens: numOpt(o['nudgeTokens'], 6000, 500, 200_000),
    autoFlag: o['autoFlag'] !== false,
    similarity: numOpt(o['similarity'], DEFAULT_REDUNDANCY.similarity, 0.5, 1),
  }
}

// ── registration ─────────────────────────────────────────────────────────────

export function register(on: On, options: PluginOptions): void {
  cfg = configOf(options)
  // A reloaded module must not inherit a previous load's half-finished work or cache clock.
  phase = 'idle'
  phaseDeadline = 0
  pendingTrimRequest = undefined
  awaitingResumeVerification = undefined
  newTurnDuringApply = false
  lastTouchAt = 0
  observedTtl = undefined
  knownTranscript = undefined
  flags = []
  flagCounter.n = 0
  turnActive = false
  coldTimer = undefined
  idleNotice = undefined
  toolsSinceNudge = 99
  openCallIds = new Set()
  vetoedAuto = new Set()
  scanPending = false
  reviewNoticeSent = false

  on('session.start', async ($, e, next) => {
    try {
      await $.tool.register({ name: 'inspect_session', description: INSPECT_DESCRIPTION, inputSchema: INSPECT_SCHEMA, isDeferred: false })
      await $.tool.register({ name: 'trim_session', description: TRIM_DESCRIPTION, inputSchema: TRIM_SCHEMA, isDeferred: false })
    } catch (err) {
      $.ui.log(`${PLUGIN}: could not register its tools: ${String(err)}`)
    }
    try {
      // Last, and guarded: a refused name must not stop the hook.
      await $.command.register({ name: 'trim-restore', description: 'Restore the session from its .jsonl_trim-backup and reload it' })
    } catch {
      /* the tools are what matter */
    }
    return next(e)
  })

  // Literal matchers (the validator reads them). A hook that throws is skipped unless its .catch answers,
  // so answer with a clear refusal rather than leave the model with a bare tool error.
  on('tool.call', { tool: 'mcp__selective-context-trim__inspect_session' }, async ($, e) => handleInspect($, e as unknown as Record<string, unknown>)).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'inspect_session hit an internal error in the selective-context-trim plugin; nothing was changed.' },
  )
  on('tool.call', { tool: 'mcp__selective-context-trim__trim_session' }, async ($, e) => handleTrim($, e as unknown as Record<string, unknown>)).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'Trim NOT queued: the selective-context-trim plugin hit an internal error; nothing was changed.' },
  )

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (phase === 'applying') newTurnDuringApply = true
      turnActive = true
      lastTouchAt = await $.clock.now()
    }
    return next(e)
  })

  // The prompt cache's clock starts when a request STARTS, so stamp each main-thread request
  // here (a transparent pass-through) and learn the cache lifetime from the API's own usage.
  on('turn.step', async function* ($, e, next) {
    let gap = 0
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      gap = lastTouchAt > 0 ? now - lastTouchAt : 0
      lastTouchAt = now
    }
    const r = yield* next(e)
    if (e.agentId === undefined) {
      noteUsage(r?.usage)
      learnTtl(gap, r?.usage)
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    if (awaitingResumeVerification && e.reason === 'resume') awaitingResumeVerification.resumeEndSeen = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId === undefined) {
      lastTouchAt = await $.clock.now()
      turnActive = false
      noteUsage(e.usage)
    }
    if (e.agentId === undefined && e.reason === 'answer' && scanPending && pendingTrimRequest === undefined && cfg.autoFlag) {
      await scanRedundancy($, false)
    }
    if (e.agentId === undefined && pendingTrimRequest === undefined && flags.length > 0) {
      // Nothing queued by the agent: re-price what it has flagged now that the turn is over, and
      // arm the cold-cache timer (applies the rest for free once the cache has expired).
      if (e.reason === 'answer') {
        $.clock.after(0, () => {
          void autoApplyFlags($, 'turn-end')
        })
      }
      await scheduleColdTimer($)
    }
    if (e.agentId === undefined && pendingTrimRequest !== undefined) {
      const job = pendingTrimRequest
      pendingTrimRequest = undefined
      if (e.reason !== 'answer') {
        phase = 'idle'
        $.ui.log(`${PLUGIN}: the turn ended early (${e.reason}); the queued trim was discarded and nothing changed.`)
      } else {
        await enterPhase($, 'applying')
        newTurnDuringApply = false
        // Not inside the hook: the turn waits on hooks, and /resume cannot run inside one.
        $.clock.after(0, () => {
          void runTrimJob($, job)
        })
      }
    }
    return out
  })

  // The engine reports the transcript file in the base fields of its classic hook events, which
  // fire whether or not any settings hook is configured. ($.session.info only exists in newer builds.)
  on('classic.SessionStart', async ($, e, next) => {
    rememberTranscript(e)
    const out = await next(e)
    if (!cfg.nudges || e.source !== 'startup') return out // not on every reload the trim itself causes
    return { ...(out ?? {}), additionalContext: [...(out?.additionalContext ?? []), STANDING_NOTE] }
  }).catch(($, e, next) => next(e)) // observation only: fail open
  on('classic.UserPromptSubmit', async ($, e, next) => {
    rememberTranscript(e)
    const out = await next(e)
    if (e.agent_id !== undefined || idleNotice === undefined) return out
    const notice = idleNotice
    idleNotice = undefined
    return { ...(out ?? {}), additionalContext: [...(out?.additionalContext ?? []), notice] }
  }).catch(($, e, next) => next(e)) // observation only: fail open
  on('classic.Stop', async ($, e, next) => {
    rememberTranscript(e)
    return next(e)
  }).catch(($, e, next) => next(e)) // observation only: fail open

  // A large result just landed: say so once, with its id, at the moment it is useful. Appended (never
  // edits earlier context), so it cannot disturb the prompt cache.
  on('classic.PostToolUse', async ($, e, next) => {
    const out = await next(e)
    const extra: string[] = []
    const hint = nudgeFor(e)
    if (hint !== undefined) extra.push(hint)
    // Our own results are pure bookkeeping: flag every older one for deletion, whatever its size.
    // The result that just arrived is skipped, so its output is the last one the agent sees.
    if (e.agent_id === undefined && e.tool_name.startsWith(OWN_TOOL_PREFIX)) {
      await scanOwnTools($, e.tool_use_id)
    }
    if (e.agent_id === undefined && !e.tool_name.startsWith(OWN_TOOL_PREFIX) && (cfg.autoFlag || cfg.nudges)) {
      // A big result may make an older one redundant. The newest result may not be readable from the
      // session yet, so it is also scanned on the next event (or at the end of the turn).
      const big = responseChars(e.tool_response) >= SCAN_RESPONSE_CHARS
      if (big || scanPending) {
        const notice = await scanRedundancy($, true)
        if (notice !== undefined) extra.push(notice)
      }
      scanPending = big
    }
    if (extra.length === 0) return out
    return { ...(out ?? {}), additionalContext: [...(out?.additionalContext ?? []), ...extra] }
  }).catch(($, e, next) => next(e)) // a hint is optional: never fail the tool result over it

  // Unattended agents cannot answer a permission prompt: pre-approve this plugin's own two tools (they only
  // edit this session's transcript). Opt out with autoAllowTools=false; nothing else is ever touched.
  on('classic.PermissionRequest', async ($, e, next) => {
    const own = e.tool_name === 'mcp__selective-context-trim__inspect_session' || e.tool_name === 'mcp__selective-context-trim__trim_session'
    if (cfg.autoAllowTools && own) return { decision: { behavior: 'allow' as const } }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (phase === 'idle' || phase === 'pending') return next(e)
    if ((await $.clock.now()) > phaseDeadline) {
      phase = 'idle'
      return next(e)
    }
    $.ui.toast('Session trim in progress — send that again in a moment.')
    return { drop: 'Selective Context Trim is reloading the session; please resend in a moment.' }
  }).catch(($, e, next) => next(e)) // a bug here must never swallow the user's prompt

  on('command.run', { command: 'trim-restore' }, async ($) => {
    if (phase !== 'idle') return { text: 'A session trim is in progress; try again in a moment.' }
    await enterPhase($, 'rolling-back')
    $.clock.after(0, () => {
      void runRestoreJob($)
    })
    return { text: 'Restoring the session from its trim backup; it will reload in a moment.' }
  }).catch(() => ({ text: 'trim-restore hit an internal error; nothing was changed.' }))
}

// ── small $-using helpers ────────────────────────────────────────────────────

async function enterPhase($: EngineInterface, p: Phase): Promise<void> {
  phase = p
  phaseDeadline = (await $.clock.now()) + PHASE_DEADLINE_MS
}

/** Newer builds report the 5m/1h cache write split; 2.1.318 does not, so read it defensively. */
function noteUsage(u: unknown): void {
  if (typeof u !== 'object' || u === null) return
  const r = u as Record<string, unknown>
  const h1 = r['ephemeral_1h_input_tokens']
  const h5 = r['ephemeral_5m_input_tokens']
  if (typeof h1 === 'number' && h1 > 0) observedTtl = '1h'
  else if (typeof h5 === 'number' && h5 > 0) observedTtl = '5m'
}

function rememberTranscript(e: { session_id?: unknown; transcript_path?: unknown }): void {
  if (typeof e.session_id === 'string' && typeof e.transcript_path === 'string' && e.transcript_path !== '') {
    knownTranscript = { sessionId: e.session_id, path: e.transcript_path }
  }
}

function platformOf(path: string, os?: string): 'windows' | 'posix' {
  return os === 'Windows_NT' || /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\') ? 'windows' : 'posix'
}

/** Claude Code's folder name for a project: every non-alphanumeric character becomes a dash. */
function encodeProject(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * Where is this session's transcript? What the engine reported, if it is for this session and
 * still exists; otherwise the standard location computed from the config dir and project.
 */
async function locateTranscript($: EngineInterface): Promise<{ path: string; platform: 'windows' | 'posix' } | undefined> {
  const id = await $.session.id()
  const os = await $.env.get('OS') // Windows sets OS=Windows_NT
  const known = knownTranscript
  if (known !== undefined && known.sessionId === id && (await $.fs.exists(known.path))) {
    return { path: known.path, platform: platformOf(known.path, os) }
  }
  try {
    const cfgDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''}/.claude`
    const dirs = [await $.session.cwd(), await $.session.root()]
    for (const d of dirs) {
      const path = `${cfgDir}/projects/${encodeProject(d)}/${id}.jsonl`
      if (await $.fs.exists(path)) return { path, platform: platformOf(path, os) }
    }
  } catch {
    /* nothing to compute from */
  }
  return undefined
}

/**
 * The newest `n` messages. Ranged reads ({ last }) exist only in newer builds (2.1.318 refuses
 * them), so read the default window — the newest 4096 entries — and slice it here.
 */
async function recentMessages($: EngineInterface, n: number) {
  const all = await $.session.messages()
  return Array.isArray(all) ? all.slice(-n) : all
}

async function cacheStateOf($: EngineInterface): Promise<CacheState> {
  let model: string | undefined
  try {
    model = await $.session.model()
  } catch {
    model = undefined
  }
  const ttl = cfg.cacheTtl === 'auto' ? (observedTtl ?? '5m') : cfg.cacheTtl
  const now = await $.clock.now()
  return {
    ttl,
    readMult: readMultFor(model, cfg.cacheReadMultiplier),
    ...(lastTouchAt > 0 ? { ageMs: Math.max(0, now - lastTouchAt) } : {}),
  }
}

/**
 * Blocks still to come before the next request, counted when judging cache reachability.
 * From inspect_session: its result, the trim_session call and result, the closing message and the
 * continuation prompt (+ margin). From trim_session: the result, the closing message, the continuation.
 */
const FUTURE_BLOCKS_INSPECT = 8
const FUTURE_BLOCKS_TRIM = 4

async function loadAnalysis(
  $: EngineInterface,
  last: number,
  futureBlocks: number,
): Promise<{ ok: true; analysis: Analysis; cache: CacheState } | { ok: false; error: string }> {
  try {
    const raw = await recentMessages($, last)
    if (!Array.isArray(raw)) return { ok: false, error: 'The session transcript is not readable right now.' }
    let usage: UsageLike | undefined
    try {
      const ctx = (await $.session.usage({ breakdown: 'summary' })).context
      usage = { window: ctx.window, ...(ctx.tokens !== undefined ? { tokens: ctx.tokens } : {}), ...(ctx.percent !== undefined ? { percent: ctx.percent } : {}), apiUsage: ctx.breakdown?.apiUsage ?? null }
    } catch {
      usage = undefined
    }
    const cache = await cacheStateOf($)
    return { ok: true, analysis: analyzeSession(raw as unknown as Msg[], usage, cfg, cache, futureBlocks), cache }
  } catch (err) {
    return { ok: false, error: `Could not read the session: ${String(err)}` }
  }
}

function clampInt(v: unknown, min: number, max: number, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d
}

// ── tool handlers ────────────────────────────────────────────────────────────

/** A tool result has to be at least this long (characters) to be worth a redundancy scan. */
const SCAN_RESPONSE_CHARS = 3000
const MAX_NOTICE_ITEMS = 3

function responseChars(response: unknown): number {
  try {
    return typeof response === 'string' ? response.length : JSON.stringify(response ?? '').length
  } catch {
    return 0
  }
}

/** Own-tool result ids worth deleting: every one except the newest and the caller's in-flight call. */
function ownToolIds(a: Analysis, skip: ReadonlySet<string>): string[] {
  const own = a.blocks.filter((b) => b.kind === 'tool' && b.id !== undefined && b.tool?.startsWith(OWN_TOOL_PREFIX) && !b.alreadyTrimmed)
  if (own.length < 2) return []
  const newest = own[own.length - 1]!.id
  return own.filter((b) => b.id !== newest && !skip.has(b.id!)).map((b) => b.id as string)
}

/** Flag the plugin's own older inspect/trim results unconditionally; the newest output stays visible. */
async function scanOwnTools($: EngineInterface, skipId?: string): Promise<void> {
  if (phase !== 'idle' && phase !== 'pending') return
  try {
    const loaded = await loadAnalysis($, WINDOW_MESSAGES, 2)
    if (!loaded.ok) return
    const ids = ownToolIds(loaded.analysis, new Set(skipId ? [skipId] : []))
    if (ids.length === 0) return
    const fresh = ownToolFlags(ids, flags, vetoedAuto, flagCounter)
    if (fresh.length === 0) return
    flags = [...flags, ...fresh]
    await scheduleColdTimer($)
  } catch (err) {
    await debug($, `own-tool flag scan failed: ${String(err)}`)
  }
}

/**
 * Finds older context that a newer result makes redundant. What is safe to act on is flagged right away
 * (the economics and the cold-cache timer decide when it is applied); what is big but uncertain is
 * returned ONCE as a short message for the agent, when `allowNotice` (a tool result is the carrier).
 * Never throws: this is an optimisation and must not disturb the turn.
 */
async function scanRedundancy($: EngineInterface, allowNotice: boolean): Promise<string | undefined> {
  scanPending = false
  try {
    if (phase !== 'idle' && phase !== 'pending') return undefined
    const loaded = await loadAnalysis($, WINDOW_MESSAGES, 2)
    if (!loaded.ok) return undefined
    const a = loaded.analysis
    const rc = redundancyConfig(cfg.similarity, cfg.charsPerToken)
    const findings = findRedundancy(docsFromAnalysis(a, rc), rc)
    if (cfg.autoFlag) {
      const isLive = (id: string) => a.blocks.some((b) => b.kind === 'tool' && b.id === id && !b.alreadyTrimmed)
      const fresh = autoFlagsFromFindings(findings, flags, vetoedAuto, flagCounter)
      flags = dropInvalidAuto([...flags, ...fresh], isLive)
      if (fresh.length > 0 && flags.length > 0) await scheduleColdTimer($)
    }
    if (!allowNotice || !cfg.nudges || reviewNoticeSent) return undefined
    const pending = new Set(flags.flatMap((f) => (f.auto ? [f.auto.oldId] : [])))
    const worth: Finding[] = findings
      .filter((f) => f.confidence === 'review' && !pending.has(f.oldId) && !vetoedAuto.has(f.oldId) && findingTokens(f, rc.charsPerToken) >= rc.reviewTokens)
      .sort((x, y) => y.savedChars - x.savedChars)
      .slice(0, MAX_NOTICE_ITEMS)
    if (worth.length === 0) return undefined
    reviewNoticeSent = true
    const items = worth.map((f) => `${describeFinding(f, rc.charsPerToken)}`).join('; ')
    return `[selective-context-trim] Possible overlap worth a look (not flagged automatically): ${items}. If the older one is superseded, flag it with trim_session; inspect_session lists these. This is mentioned only once.`
  } catch (err) {
    await debug($, `redundancy scan failed: ${String(err)}`)
    return undefined
  }
}

async function handleInspect($: EngineInterface, e: Record<string, unknown>): Promise<{ result: string } | { deny: string }> {
  if (e['agentId']) return { deny: 'inspect_session only works in the main conversation, not in a subagent.' }
  const loaded = await loadAnalysis($, clampInt(e['last_messages'], 20, 1000, 150), FUTURE_BLOCKS_INSPECT)
  if (!loaded.ok) return { deny: loaded.error }
  const text = renderInspect(loaded.analysis, {
    minTokens: clampInt(e['min_tokens'], 100, 50_000, 500),
    maxRows: clampInt(e['max_rows'], 3, 60, 20),
    includeText: true,
  })
  const rc = redundancyConfig(cfg.similarity, cfg.charsPerToken)
  const found = redundancyLines(findRedundancy(docsFromAnalysis(loaded.analysis, rc), rc), new Set(flags.flatMap((f) => (f.auto ? [f.auto.oldId] : []))), cfg.charsPerToken)
  const body = found === '' ? text : `${text}\n\n${found}`
  return { result: flags.length > 0 ? `Pending flags: ${describeFlags(flags)}\n\n${body}` : body }
}

async function handleTrim($: EngineInterface, e: Record<string, unknown>): Promise<{ result: string } | { deny: string }> {
  if (e['agentId']) return { deny: 'trim_session only works in the main conversation, not in a subagent.' }
  if (phase !== 'idle' && phase !== 'pending') return { deny: 'A session trim/reload is already in progress. Wait for it to finish.' }

  const unflagKeys = Array.isArray(e['unflag']) ? (e['unflag'] as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const count = (k: string) => (Array.isArray(e[k]) ? (e[k] as unknown[]).length : 0)
  const hasItems = count('tool_targets') + count('regex_rules') > 0
  const callId = typeof e['tool_use_id'] === 'string' && e['tool_use_id'] !== '' ? e['tool_use_id'] : undefined

  let prefix = ''
  if (unflagKeys.length > 0) {
    const r = removeFlags(flags, unflagKeys)
    flags = r.flags
    for (const f of r.removed) if (f.auto) vetoedAuto.add(f.auto.oldId) // the agent said no: never re-flag it
    prefix = r.removed.length > 0 ? `Unflagged ${r.removed.length} (${describeFlags(r.removed)}). ` : `Nothing matched ${unflagKeys.join(', ')} to unflag. `
    if (flags.length === 0) {
      coldTimer?.cancel()
      coldTimer = undefined
    }
  }
  if (!hasItems) {
    if (unflagKeys.length === 0 && e['list'] !== true) {
      return { deny: 'Nothing to flag: pass tool_targets and/or regex_rules (ids appear in the hints after large results and in inspect_session), or unflag / list.' }
    }
    return { result: await statusText($, prefix) }
  }

  const v = validateTrimParams(e)
  if (!v.ok) return { deny: `Not flagged: ${v.error}` }
  if (callId !== undefined && v.request.targets.some((t) => t.id === callId)) return { deny: 'Not flagged: trim_session cannot target its own call.' }
  if (!(await locateTranscript($))) return { deny: "Not flagged: this session's transcript file could not be located, so it cannot be rewritten." }

  const loaded = await loadAnalysis($, WINDOW_MESSAGES, FUTURE_BLOCKS_TRIM)
  if (!loaded.ok) return { deny: `Not flagged: ${loaded.error}` }
  const a = loaded.analysis
  const estNew = estimatePlan(a, v.request)
  if (estNew.errors.length > 0) return { deny: `Not flagged:\n- ${estNew.errors.join('\n- ')}` }
  if (estNew.S === 0 && !v.force) return { deny: `Not flagged: nothing to trim was found in the recent messages (${estNew.warnings.join(' ') || 'no matches'}).` }

  // A second call in the same turn adds to what was already queued instead of replacing it.
  const carried: Flag[] = pendingTrimRequest ? flagsFromRequest(pendingTrimRequest.request, flagCounter) : []
  // Merge with what is already flagged, dropping flags whose results are gone.
  const stillThere = (f: Flag) => flagToolIds(f).every((id) => a.blocks.some((b) => b.kind === 'tool' && b.id === id && !b.alreadyTrimmed))
  const isLive = (id: string) => a.blocks.some((b) => b.kind === 'tool' && b.id === id && !b.alreadyTrimmed)
  const kept = [...flags, ...carried].filter(stillThere)
  const withRequest = addFlags(kept, v.request.targets, v.request.rules, flagCounter, callId, v.request.note)
  // A second flag for the same target only overrides its mode/replacement. Say nothing: no "already
  // flagged" chatter, no second flag, and no extra status to sit in the context.
  const duplicateOnly = withRequest.length === kept.length && withRequest.every((f, i) => kept[i]?.id === f.id)
  const ownFresh = ownToolFlags(ownToolIds(a, new Set(callId ? [callId] : [])), withRequest, vetoedAuto, flagCounter)
  // Automatic flags only stand while the newer copy that keeps the content is untouched (the agent may just have flagged it).
  const merged = dropInvalidAuto([...withRequest, ...ownFresh], isLive)
  const estAll = estimatePlan(a, requestFromFlags(merged, v.request.note))
  const all = judge(
    {
      S: estAll.S,
      C: a.contextTokens,
      items: merged.length,
      ...(estAll.reentry ? { reentry: estAll.reentry } : {}),
      ...(a.percent !== undefined ? { percent: a.percent } : {}),
      ...(v.expectedRequests !== undefined ? { expectedRequests: v.expectedRequests } : {}),
    },
    loaded.cache,
    cfg,
  )
  // Agent trims are deferred by default: they join the normal pending flow and the automatic trimmer
  // applies them when they pay off, or for free once the cache is cold. `force: true` is the explicit
  // "do it now" for a significant change; even then a costly set is never forced.
  const choice = choosePayingSubset(a, merged, loaded.cache, v.expectedRequests, v.request.note)
  const take: Flag[] | undefined = v.force ? (choice ? choice.subset : all.zone !== 'costly' ? merged : undefined) : undefined
  // An unscoped regex rule would also hit text that does not exist yet, so it can never wait.
  const unscopedFlags = merged.filter((f) => f.rule !== undefined && !deferrable(f.rule))

  if (take !== undefined) {
    const verdict = choice ? choice.verdict : all
    const leftover = merged.filter((f) => !take.includes(f) && !unscopedFlags.includes(f))
    const ids = [...(pendingTrimRequest?.trimCallIds ?? [])]
    if (callId && !ids.includes(callId)) ids.push(callId)
    const autoN = autoCount(take)
    const ownN = take.filter((f) => f.auto?.kind === 'own-tool').length
    const earlier = take.filter((f) => kept.includes(f) && !f.auto).length
    flags = leftover
    // Earlier flagging calls whose flags are all resolved now: this rewrite clears them too.
    const settledCallIds = settledCalls(openCallIds, flags).filter((x) => !ids.includes(x))
    pendingTrimRequest = { source: 'agent', continueAfter: true, flagCount: take.length, request: requestFromFlags(take, v.request.note), trimCallIds: ids, settledCallIds, autoCount: autoN, ownAutoCount: ownN, verdict }
    phase = 'pending'
    coldTimer?.cancel()
    coldTimer = undefined
    if (flags.length > 0) await scheduleColdTimer($)
    const rest = leftover.length > 0 ? ` ${leftover.length} other flagged item(s) stay pending.` : ''
    const dropped = unscopedFlags.some((f) => !take.includes(f)) ? ' An unscoped regex rule cannot wait and was not kept: add scope_tool_ids to defer it.' : ''
    const withAuto = autoN > 0 ? ` (Also includes ${autoN} automatic flag${autoN === 1 ? '' : 's'}.)` : ''
    return { result: `${prefix}${QUEUED_TEXT}${earlier > 0 ? ` (Includes ${earlier} item(s) flagged earlier.)` : ''}${withAuto}${rest}${dropped} Estimate: ${verdict.summary}.` }
  }

  if (unscopedFlags.length > 0) {
    return { deny: `${adviceFor(all, cfg)} (An unscoped regex rule cannot wait: add scope_tool_ids to let it stay pending, or pass force: true to apply it now.)` }
  }
  flags = merged
  if (callId && merged.some((f) => f.callId === callId)) openCallIds.add(callId)
  await scheduleColdTimer($)
  const forced = v.force && all.zone === 'costly' ? 'It stays pending even with force: applying it now would re-process far more than it saves. ' : ''
  if (duplicateOnly && unflagKeys.length === 0 && !v.force) return { result: '' }
  return {
    result:
      `${prefix}${forced}Flagged. ${merged.length} item(s) pending (≈${fmtTok(estAll.S)} tok): ${describeFlags(merged)}. Not applied yet — ${all.summary}. ` +
      'No action needed: they apply automatically when they pay off (more flags, context pressure) or once the prompt cache has expired. ' +
      'Pass force: true to apply them at the end of this turn instead. ' +
      'Cancel with {"unflag":["f1"]}; review with {"list":true}. Carry on with your task.',
  }
}

/**
 * The best set to apply now: grow the set newest-first (each added flag reaches further back) and keep
 * the best prefix that passes the cache check. An old flag that would drag a recent one over the
 * line simply stays pending.
 */
function choosePayingSubset(
  a: Analysis,
  list: readonly Flag[],
  cache: CacheState,
  expectedRequests: number | undefined,
  note: string,
): { subset: Flag[]; est: PlanEstimate; verdict: Verdict } | undefined {
  const pos = (f: Flag) => positionOf(a, f.target ? { id: f.target.id, mode: f.target.mode } : undefined, f.rule?.scopeToolIds ?? [])
  const ranked = [...list].sort((x, y) => pos(y) - pos(x))
  let best: { subset: Flag[]; est: PlanEstimate; verdict: Verdict } | undefined
  for (let k = 1; k <= ranked.length; k++) {
    const subset = ranked.slice(0, k)
    const est = estimatePlan(a, requestFromFlags(subset, note))
    if (est.errors.length > 0 || est.S === 0) continue
    const verdict = judge(
      {
        S: est.S,
        C: a.contextTokens,
        items: subset.length,
        ...(est.reentry ? { reentry: est.reentry } : {}),
        ...(a.percent !== undefined ? { percent: a.percent } : {}),
        ...(expectedRequests !== undefined ? { expectedRequests } : {}),
      },
      cache,
      cfg,
    )
    if (verdict.zone === 'good' && (best === undefined || verdict.longTerm > best.verdict.longTerm)) best = { subset, est, verdict }
  }
  return best
}

/** Re-price the flags against the live conversation. */
async function evaluateFlags($: EngineInterface, list: Flag[], future: number) {
  const loaded = await loadAnalysis($, WINDOW_MESSAGES, future)
  if (!loaded.ok) return loaded
  const a = loaded.analysis
  const live = list.filter((f) => flagToolIds(f).every((id) => a.blocks.some((b) => b.kind === 'tool' && b.id === id && !b.alreadyTrimmed)))
  const combined = requestFromFlags(live, DEFAULT_NOTE)
  const est = estimatePlan(a, combined)
  const verdict = judge(
    {
      S: est.S,
      C: a.contextTokens,
      items: live.length,
      ...(est.reentry ? { reentry: est.reentry } : {}),
      ...(a.percent !== undefined ? { percent: a.percent } : {}),
    },
    loaded.cache,
    cfg,
  )
  return { ok: true as const, live, combined, est, verdict }
}

async function statusText($: EngineInterface, prefix: string): Promise<string> {
  if (flags.length === 0) return `${prefix}No flagged items are pending.`
  const loaded = await loadAnalysis($, WINDOW_MESSAGES, FUTURE_BLOCKS_TRIM)
  if (!loaded.ok) return `${prefix}${flags.length} item(s) flagged: ${describeFlags(flags)}.`
  const a = loaded.analysis
  const live = flags.filter((f) => flagToolIds(f).every((id) => a.blocks.some((b) => b.kind === 'tool' && b.id === id && !b.alreadyTrimmed)))
  const est = estimatePlan(a, requestFromFlags(live, DEFAULT_NOTE))
  const choice = choosePayingSubset(a, live, loaded.cache, undefined, DEFAULT_NOTE)
  const state = choice
    ? `${choice.subset.length} of them pay off now (${describeFlags(choice.subset)}): they apply when your turn ends, or call trim_session with force: true to queue them immediately`
    : 'none pays off yet'
  return `${prefix}Pending ${live.length} item(s), ≈${fmtTok(est.S)} tok: ${describeFlags(live)}. Status: ${state}. Automatic triggers: it pays off, context pressure, or the prompt cache expires.`
}

function cacheTtlMs(): number {
  return TTL_MS[cfg.cacheTtl === 'auto' ? (observedTtl ?? '5m') : cfg.cacheTtl]
}

/** Arm (or re-arm) the timer that fires when the prompt cache has expired. */
async function scheduleColdTimer($: EngineInterface): Promise<void> {
  coldTimer?.cancel()
  coldTimer = undefined
  if (flags.length === 0) return
  const override = Number(await $.env.get('TRIM_COLD_AFTER_MS')) // test hook: fire after this many ms
  const now = await $.clock.now()
  const due = override > 0 ? override : Math.max(1000, cacheTtlMs() - (lastTouchAt > 0 ? now - lastTouchAt : 0) + COLD_MARGIN_MS)
  coldTimer = $.clock.after(due, () => {
    void autoApplyFlags($, 'cold')
  })
}

/**
 * Apply the pending flags without the agent: at the end of a turn if they now pay off, or once the
 * prompt cache has expired (then the whole prefix is rewritten anyway, so the rewrite is free).
 */
async function autoApplyFlags($: EngineInterface, trigger: 'turn-end' | 'cold'): Promise<void> {
  try {
    if (flags.length === 0 || phase !== 'idle' || turnActive || pendingTrimRequest !== undefined) return
    if (trigger === 'cold') {
      const override = Number(await $.env.get('TRIM_COLD_AFTER_MS'))
      const age = lastTouchAt > 0 ? (await $.clock.now()) - lastTouchAt : Infinity
      if (!(override > 0) && age < cacheTtlMs()) {
        await scheduleColdTimer($) // not expired yet: wait for the rest of it
        return
      }
    }
    const loaded = await loadAnalysis($, WINDOW_MESSAGES, 2)
    if (!loaded.ok) return
    const a = loaded.analysis
    const isLive = (id: string) => a.blocks.some((b) => b.kind === 'tool' && b.id === id && !b.alreadyTrimmed)
    flags = dropInvalidAuto(flags.filter((f) => flagToolIds(f).every(isLive)), isLive)
    if (flags.length === 0) return
    let take: Flag[] | undefined
    let verdict: Verdict | undefined
    if (trigger === 'cold') {
      // Cold cache: nothing extra is recomputed, so any saving that is worth a reload is free.
      const est = estimatePlan(a, requestFromFlags(flags, DEFAULT_NOTE))
      if (est.errors.length === 0 && est.S >= Math.min(cfg.minSavingsTokens, 1500)) {
        take = flags
        verdict = judge({ S: est.S, C: a.contextTokens, items: flags.length, ...(est.reentry ? { reentry: est.reentry } : {}) }, loaded.cache, cfg)
      }
    } else {
      const choice = choosePayingSubset(a, flags, loaded.cache, undefined, DEFAULT_NOTE)
      if (choice) {
        take = choice.subset
        verdict = choice.verdict
      }
    }
    if (take === undefined || verdict === undefined) return
    const autoN = autoCount(take)
    const ownN = take.filter((f) => f.auto?.kind === 'own-tool').length
    flags = flags.filter((f) => !take.includes(f))
    // Deferred agent flags carry their call id and session note. Keep the newest flagging call's short
    // output (collapsed to that note); older ones are cleared like any settled call.
    const at = (id: string) => a.blocks.findIndex((b) => b.kind === 'tool' && b.id === id)
    const newestCall = take
      .flatMap((f) => (f.callId ? [f.callId] : []))
      .filter((id) => at(id) >= 0)
      .reduce<string | undefined>((best, id) => (best === undefined || at(id) > at(best) ? id : best), undefined)
    const trimCallIds = newestCall ? [newestCall] : []
    const note = take.find((f) => f.callId === newestCall)?.note ?? take.find((f) => f.note)?.note ?? DEFAULT_NOTE
    const job: PendingTrimRequest = {
      source: trigger,
      continueAfter: false,
      flagCount: take.length,
      request: requestFromFlags(take, note),
      trimCallIds,
      settledCallIds: settledCalls(openCallIds, flags).filter((x) => !trimCallIds.includes(x)),
      autoCount: autoN,
      ownAutoCount: ownN,
      verdict,
    }
    coldTimer?.cancel()
    coldTimer = undefined
    if (flags.length > 0) await scheduleColdTimer($)
    await enterPhase($, 'applying')
    newTurnDuringApply = false
    await runTrimJob($, job)
  } catch (err) {
    phase = 'idle'
    await debug($, `auto-apply failed: ${String(err)}`)
  }
}

/** The prompt cache outlived what we assumed (a long gap, still warm): the lifetime is the long one. */
function learnTtl(gapMs: number, usage: unknown): void {
  if (gapMs < 6 * 60_000 || typeof usage !== 'object' || usage === null) return
  const u = usage as Record<string, unknown>
  const read = u['cache_read_input_tokens']
  const created = u['cache_creation_input_tokens']
  if (typeof read === 'number' && typeof created === 'number' && read + created > 0) observedTtl = read >= created ? '1h' : '5m'
}

function nudgeFor(e: { agent_id?: string; tool_name: string; tool_use_id: string; tool_response: unknown }): string | undefined {
  if (!cfg.nudges || e.agent_id !== undefined || e.tool_name.startsWith('mcp__selective-context-trim__')) return undefined
  toolsSinceNudge += 1
  let chars = 0
  try {
    chars = typeof e.tool_response === 'string' ? e.tool_response.length : JSON.stringify(e.tool_response ?? '').length
  } catch {
    chars = 0
  }
  const tokens = tokensOfChars(chars)
  if (tokens < cfg.nudgeTokens || toolsSinceNudge < 3) return undefined
  toolsSinceNudge = 0
  return `[selective-context-trim] That ${e.tool_name} result is about ${fmtTok(tokens)} tokens (tool_use_id ${e.tool_use_id}). Once you have noted what you need from it, flag it with trim_session — flagging is free; it is applied only when it pays off or the prompt cache has expired.`
}

function tokensOfChars(chars: number): number {
  return Math.ceil(chars / cfg.charsPerToken)
}

// ── the end-of-turn pipeline ─────────────────────────────────────────────────

function continuationText(note: string, autoN = 0, ownN = 0): string {
  const redundantN = autoN - ownN
  const bits: string[] = []
  if (redundantN > 0) bits.push(`${redundantN} redundant older cop${redundantN === 1 ? 'y' : 'ies'} that newer results supersede`)
  if (ownN > 0) bits.push(`${ownN} result${ownN === 1 ? '' : 's'} from this plugin's own tools`)
  const extra = bits.length > 0 ? ` Also trimmed ${bits.join(' and ')}.` : ''
  return `${note}${/[.!?]$/.test(note) ? '' : '.'}${extra} Continue with your task.`
}

function summaryLine(r: TrimReport): string {
  const parts: string[] = []
  if (r.stubbed.length > 0) parts.push(`${r.stubbed.length} result${r.stubbed.length === 1 ? '' : 's'} stubbed/summarised`)
  if (r.deleted.length > 0) parts.push(`${r.deleted.length} call${r.deleted.length === 1 ? '' : 's'} deleted`)
  const matches = r.rules.reduce((n, x) => n + x.matches, 0)
  if (matches > 0) parts.push(`${matches} regex match${matches === 1 ? '' : 'es'}`)
  if (r.settledCleared.length > 0) parts.push(`${r.settledCleared.length} earlier flagging call${r.settledCleared.length === 1 ? '' : 's'} cleared`)
  const saved = Math.round(r.savedChars / DEFAULT_ECON.charsPerToken)
  return `${parts.join(', ') || 'no content changes'} (≈${fmtTok(saved)} tokens freed; the next request re-caches the tail)`
}

/** Tell the agent (it ended its turn expecting a reload) and the user. */
function notify($: EngineInterface, userLine: string, agentText: string | undefined): void {
  $.ui.log(`${PLUGIN}: ${userLine}`)
  if (agentText !== undefined) {
    $.prompt.submit({ text: agentText }).catch(() => undefined)
  }
}

async function runTrimJob($: EngineInterface, job: PendingTrimRequest): Promise<void> {
  const idle = job.source !== 'agent'
  // While the agent is idle, prompting it would spend a request for nothing: tell it with its next prompt instead.
  const tell = (user: string, agent: string) => {
    notify($, user, idle ? undefined : agent)
    if (idle) idleNotice = agent
  }
  try {
    const applied = await applyToDisk($, job)
    if (!applied.ok) {
      phase = 'idle'
      tell(`trim aborted — ${applied.error}`, `Session trim aborted: ${applied.error} Nothing was changed.${idle ? '' : ' Continue with your task.'}`)
      return
    }
    if (applied.noop) {
      phase = 'idle'
      notify($, 'the trim matched nothing; nothing changed.', idle ? undefined : 'Session trim made no changes: nothing matched. Continue with your task.')
      return
    }
    await debug($, `transcript rewritten; reloading (source ${job.source})`)
    await enterPhase($, 'reloading')
    awaitingResumeVerification = applied.awaiting
    const ok = await reloadWithStrategy($, applied.awaiting)
    if (ok) {
      const note = applied.awaiting.note
      awaitingResumeVerification = undefined
      phase = 'idle'
      for (const id of [...job.trimCallIds, ...applied.report.settledCleared, ...applied.report.deleted.map((d) => d.id)]) openCallIds.delete(id)
      const line = `${summaryLine(applied.report)}. Backup kept: ${applied.awaiting.backupPath}`
      if (!idle) {
        notify($, line, cfg.autoContinue && job.continueAfter ? continuationText(note, job.autoCount, job.ownAutoCount) : undefined)
      } else {
        const why = job.source === 'cold' ? 'the prompt cache had expired, so ' : ''
        const mine = job.flagCount - job.autoCount
        const redundantN = job.autoCount - job.ownAutoCount
        const groups = [redundantN > 0 ? `${redundantN} redundant older cop${redundantN === 1 ? 'y' : 'ies'}` : '', job.ownAutoCount > 0 ? `${job.ownAutoCount} own-tool result${job.ownAutoCount === 1 ? '' : 's'}` : ''].filter(Boolean)
        const what = groups.length > 0 ? `${job.flagCount} item(s) (${groups.join(', ')})` : `${job.flagCount} flagged item(s)`
        notify($, `${why}${what} were trimmed while idle — ${line}`, undefined)
        const who = [mine > 0 ? `${mine} result(s) you flagged` : '', redundantN > 0 ? `${redundantN} redundant older cop${redundantN === 1 ? 'y' : 'ies'} that newer results supersede` : '', job.ownAutoCount > 0 ? `${job.ownAutoCount} result${job.ownAutoCount === 1 ? '' : 's'} from this plugin's own tools` : ''].filter(Boolean).join(' and ')
        idleNotice = `While you were idle, ${who} were trimmed (${summaryLine(applied.report)}). They now read [Trimmed …] in your context.`
      }
    } else {
      await rollback($, applied.awaiting)
    }
  } catch (err) {
    const aw = awaitingResumeVerification
    if (aw) await rollback($, aw)
    else {
      phase = 'idle'
      tell(`trim aborted — ${String(err)}`, `Session trim aborted: ${String(err)} Nothing was changed.${idle ? '' : ' Continue with your task.'}`)
    }
  }
}

type Applied =
  | { ok: true; noop: true; report: TrimReport }
  | { ok: true; noop?: false; report: TrimReport; awaiting: AwaitingResumeVerification }
  | { ok: false; error: string }

async function applyToDisk($: EngineInterface, job: PendingTrimRequest): Promise<Applied> {
  const loc = await locateTranscript($)
  if (!loc) return { ok: false, error: 'this session\'s transcript file could not be located.' }
  const path = loc.path
  const platform = loc.platform
  const sessionId = await $.session.id()
  const backupPath = `${path}_trim-backup`

  // Without a trim_session call to look at, the reload is verified against what the flagged results looked like before.
  const before = await recentMessages($, WINDOW_MESSAGES)
  const lenById = new Map<string, number>()
  if (Array.isArray(before)) for (const m of before) for (const u of m.toolUses) lenById.set(u.tool_use_id, u.text?.length ?? 0)
  const verify: VerifyEntry[] = [
    ...job.request.targets.map((t) => ({ id: t.id, mode: t.mode, before: lenById.get(t.id) ?? -1 })),
    ...job.request.rules.flatMap((r) => (r.scopeToolIds ?? []).map((id) => ({ id, mode: 'rule' as const, before: lenById.get(id) ?? -1 }))),
  ]

  const snap = await waitForFlush($, path, job.trimCallIds)
  if (!snap) return { ok: false, error: 'the transcript did not finish flushing in time.' }
  if (!snap.whole && platform === 'windows') {
    return { ok: false, error: 'transcripts over 3.5 MiB are not supported on Windows yet.' }
  }

  const res: TranscriptResult = applyTrimToTranscript(snap.lines, job.request, { trimCallIds: job.trimCallIds, settledCallIds: job.settledCallIds })
  if (!res.ok) return { ok: false, error: res.error }
  if (!res.report.changed) return { ok: true, noop: true, report: res.report }
  if (newTurnDuringApply) return { ok: false, error: 'a new turn started while preparing; trim cancelled.' }
  if ((await $.fs.stat(path)).size !== snap.size) return { ok: false, error: 'the transcript changed while preparing; trim cancelled.' }

  // Single-slot backup: overwritten by every trim, never ending in .jsonl.
  await copyFileVia($, path, backupPath, platform, snap.size)
  let expectedSize = 0
  try {
    expectedSize = await replaceTranscript($, path, snap, res, platform)
  } catch (err) {
    try {
      await restoreBackup($, path, backupPath, platform)
    } catch {
      /* reported below */
    }
    return { ok: false, error: `could not write the trimmed transcript (${String(err)}); the original was restored.` }
  }
  return {
    ok: true,
    report: res.report,
    awaiting: {
      source: job.source,
      verify,
      sessionId,
      transcriptPath: path,
      backupPath,
      retries: 0,
      trimCallIds: [...job.trimCallIds],
      note: job.request.note,
      resumeEndSeen: false,
      expectedSize,
    },
  }
}

// ── file access (everything goes through $.fs / $.process) ───────────────────

async function readSnapshot($: EngineInterface, path: string): Promise<Snapshot | undefined> {
  try {
    const size = (await $.fs.stat(path)).size
    let text: string
    let start = 0
    let whole = true
    if (size <= WHOLE_FILE_MAX) {
      text = (await $.fs.read(path)) as string
    } else {
      // $.fs.read has no byte ranges in 2.1.318: tail -c gives the last bytes (up to 4 MiB of stdout).
      const r = await $.process.run(['tail', '-c', String(WHOLE_FILE_MAX), path], { timeoutMs: 20_000 })
      if (r.exitCode !== 0 || (r as { isStdoutTruncated?: boolean }).isStdoutTruncated === true) return undefined
      const chunk = r.stdout
      const nl = chunk.indexOf('\n')
      if (nl < 0) return undefined
      text = chunk.slice(nl + 1) // the first line is cut mid-way: drop it
      start = size - byteLength(text)
      whole = false
    }
    const complete = text === '' || text.endsWith('\n')
    const lines = text.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    return { size, start, lines, whole, complete }
  } catch {
    return undefined
  }
}

/** Wait until the transcript holds the trim_session result(s) and has stopped growing. */
async function waitForFlush($: EngineInterface, path: string, ids: readonly string[]): Promise<Snapshot | undefined> {
  const began = await $.clock.now()
  let lastSize = -1
  while ((await $.clock.now()) - began < FLUSH_TIMEOUT_MS) {
    const snap = await readSnapshot($, path)
    if (snap && snap.complete && snap.size === lastSize && ids.every((id) => snap.lines.some((l) => l.includes(id) && l.includes('tool_result')))) {
      return snap
    }
    lastSize = snap ? snap.size : -1
    await $.clock.sleep(120)
  }
  return undefined
}

async function run($: EngineInterface, argv: string[]): Promise<void> {
  const r = await $.process.run(argv, { timeoutMs: 20_000 })
  if (r.exitCode !== 0) throw new Error(`${argv[0]} exited ${r.exitCode}: ${r.stderr.trim().slice(0, 200)}`)
}

async function moveFile($: EngineInterface, from: string, to: string, platform: string): Promise<void> {
  if (platform === 'windows') {
    await run($, ['cmd', '/d', '/s', '/c', 'move', '/Y', from, to])
    return
  }
  // Session transcripts are private (0600). A freshly written temp file gets the default umask,
  // so tighten it BEFORE it replaces the real file, or the swap would make the transcript world-readable.
  await run($, ['chmod', '600', from])
  // rename(2) via mv: atomic within a directory.
  await run($, ['mv', '-f', from, to])
}

/** Copy via a temp file in the same folder, then rename: the destination is never half-written. */
async function copyFileVia($: EngineInterface, src: string, dst: string, platform: string, size: number): Promise<void> {
  const tmp = `${dst}.tmp`
  if (size <= WHOLE_FILE_MAX) {
    await $.fs.write(tmp, (await $.fs.read(src)) as string)
  } else if (platform === 'windows') {
    await run($, ['cmd', '/d', '/s', '/c', 'copy', '/Y', src, tmp])
  } else {
    await run($, ['cp', '-f', src, tmp])
  }
  await moveFile($, tmp, dst, platform)
}

async function restoreBackup($: EngineInterface, path: string, backupPath: string, platform: string): Promise<void> {
  const size = (await $.fs.stat(backupPath)).size
  // Copy, don't move: the single backup stays on disk until the next trim overwrites it.
  const tmp = `${path}.restore.tmp`
  if (size <= WHOLE_FILE_MAX) {
    await $.fs.write(tmp, (await $.fs.read(backupPath)) as string)
  } else if (platform === 'windows') {
    await run($, ['cmd', '/d', '/s', '/c', 'copy', '/Y', backupPath, tmp])
  } else {
    await run($, ['cp', '-f', backupPath, tmp])
  }
  await moveFile($, tmp, path, platform)
}

/**
 * Write the trimmed transcript atomically (temp file, then rename). A whole-file
 * rewrite when the file is small; otherwise only the changed tail is rebuilt and
 * spliced onto the untouched head with head/cat.
 */
async function replaceTranscript($: EngineInterface, path: string, snap: Snapshot, res: Extract<TranscriptResult, { ok: true }>, platform: string): Promise<number> {
  const tmp = `${path}.trim-new.tmp`
  let expected: number
  if (snap.whole) {
    const text = res.lines.length > 0 ? res.lines.join('\n') + '\n' : ''
    await $.fs.write(tmp, text)
    expected = byteLength(text)
  } else {
    let head = 0
    for (let i = 0; i < res.changedFrom; i++) head += byteLength(snap.lines[i] ?? '') + 1
    const splice = snap.start + head
    const tailText = res.lines.length > res.changedFrom ? res.lines.slice(res.changedFrom).join('\n') + '\n' : ''
    const tailTmp = `${path}.trim-tail.tmp`
    await $.fs.write(tailTmp, tailText)
    await run($, ['sh', '-c', 'head -c "$1" "$2" > "$3" && cat "$4" >> "$3"', 'sh', String(splice), path, tmp, tailTmp])
    await run($, ['rm', '-f', tailTmp]).catch(() => undefined)
    expected = splice + byteLength(tailText)
  }
  const got = (await $.fs.stat(tmp)).size
  if (got !== expected) throw new Error(`temp file is ${got} bytes, expected ${expected}`)
  await moveFile($, tmp, path, platform)
  return expected
}

// ── reload, verification, rollback ───────────────────────────────────────────

async function readLearned($: EngineInterface): Promise<Strategy | undefined> {
  try {
    const v = (await $.store.get('reloadStrategy')) as unknown
    return v === 'direct' || v === 'clear-resume' ? v : undefined
  } catch {
    return undefined
  }
}

async function remember($: EngineInterface, s: Strategy): Promise<void> {
  try {
    await $.store.set('reloadStrategy', s)
  } catch {
    /* a convenience only */
  }
}

/**
 * Has the engine really loaded the rewritten transcript? `session.start` does not
 * fire on /resume, so look at what the engine now holds: the collapsed
 * trim_session result must no longer read "queued" (or, after a rollback, must).
 */
/** Verification for a harness-initiated trim: did the flagged result change (or, after a revert, come back)? */
function flagStateReloaded(
  msgs: readonly { toolUses: readonly { tool_use_id: string; text?: string }[] }[],
  aw: AwaitingResumeVerification,
  expect: 'trimmed' | 'reverted',
): boolean {
  const v = aw.verify.find((x) => x.before >= 0 || x.mode === 'delete')
  if (!v) return aw.resumeEndSeen
  const use = msgs.flatMap((m) => m.toolUses).find((u) => u.tool_use_id === v.id)
  if (expect === 'trimmed') {
    if (v.mode === 'delete') return use === undefined
    if (use === undefined || use.text === undefined) return false
    return v.mode === 'rule' ? use.text.length < v.before : use.text.startsWith('[Trimmed')
  }
  if (v.mode === 'delete') return use !== undefined
  return use !== undefined && use.text !== undefined && use.text.length === v.before
}

async function isReloaded($: EngineInterface, aw: AwaitingResumeVerification, expect: 'trimmed' | 'reverted'): Promise<boolean> {
  try {
    if ((await $.session.id()) !== aw.sessionId) return false
    const msgs = await recentMessages($, aw.trimCallIds.length > 0 ? 80 : WINDOW_MESSAGES)
    if (!Array.isArray(msgs)) return false
    if (aw.trimCallIds.length === 0) return flagStateReloaded(msgs, aw, expect)
    for (const m of msgs) {
      for (const u of m.toolUses) {
        if (!aw.trimCallIds.includes(u.tool_use_id)) continue
        if (u.text === undefined) return aw.resumeEndSeen
        const queued = u.text.includes(QUEUED_MARK)
        return expect === 'trimmed' ? !queued : queued
      }
    }
    return false
  } catch {
    return false
  }
}

/**
 * Opt-in diagnostics: with TRIM_DEBUG_LOG=<file> in the environment, every phase appends a timestamped line.
 * Off by default; costs one env lookup per call.
 */
async function debug($: EngineInterface, msg: string): Promise<void> {
  try {
    const path = await $.env.get('TRIM_DEBUG_LOG')
    if (!path) return
    const prev = (await $.fs.exists(path)) ? ((await $.fs.read(path)) as string) : ''
    await $.fs.write(path, `${prev}${await $.clock.now()} ${msg}\n`)
  } catch {
    /* diagnostics must never affect the real work */
  }
}

/** Claude Code answers many failed commands with text instead of throwing. */
function looksLikeFailure(text: string | undefined): boolean {
  return text !== undefined && /no conversations? found|not found|could not|couldn't|cannot|can't|failed|error|unable|invalid|does not exist|doesn't exist/i.test(text)
}

async function fileIsIntact($: EngineInterface, aw: AwaitingResumeVerification): Promise<boolean> {
  try {
    return (await $.fs.stat(aw.transcriptPath)).size >= aw.expectedSize
  } catch {
    return false
  }
}

type ReloadStatus = 'ok' | 'noop' | 'failed'

/**
 * Dispatch one reload and watch for the engine to show the expected state.
 *  ok      the reloaded session is what we expect
 *  noop    the command finished but changed nothing (resume of the open session can do that)
 *  failed  it threw, or the watchdog ran out: the file is the likely culprit, so do not escalate
 */
async function reloadOnce($: EngineInterface, aw: AwaitingResumeVerification, strategy: Strategy, expect: 'trimmed' | 'reverted'): Promise<ReloadStatus> {
  aw.resumeEndSeen = false
  delete aw.lastError
  delete aw.lastText
  let commandDone = false
  const began = await $.clock.now()
  await debug($, `reload start strategy=${strategy} expect=${expect}`)
  void (async () => {
    try {
      if (strategy === 'clear-resume') await $.command.run({ command: 'clear', args: '' })
      const r = await $.command.run({ command: 'resume', args: aw.sessionId })
      aw.lastText = typeof r?.text === 'string' ? r.text : undefined
    } catch (err) {
      aw.lastError = String(err)
    }
    commandDone = true
    await debug($, `resume command returned text=${JSON.stringify(aw.lastText ?? null)} error=${JSON.stringify(aw.lastError ?? null)}`)
  })()
  for (;;) {
    if (await isReloaded($, aw, expect)) {
      await debug($, 'reload verified ok')
      return 'ok'
    }
    if (aw.lastError !== undefined) return 'failed'
    // The engine said it could not resume (as text): that is a failure, not a no-op. Never /clear over it.
    if (commandDone && !aw.resumeEndSeen && looksLikeFailure(aw.lastText)) {
      await debug($, 'reload failed: the engine reported a failure as text')
      return 'failed'
    }
    const elapsed = (await $.clock.now()) - began
    if (elapsed >= cfg.resumeTimeoutMs) {
      await debug($, `reload failed: watchdog after ${elapsed}ms`)
      return 'failed'
    }
    // /resume of the session already open can be a no-op: don't wait out the watchdog for it.
    if (strategy === 'direct' && commandDone && !aw.resumeEndSeen && elapsed >= NOOP_DETECT_MS) {
      await debug($, 'reload judged a no-op (command finished, nothing changed)')
      return 'noop'
    }
    await $.clock.sleep(150)
  }
}

async function reloadWithStrategy($: EngineInterface, aw: AwaitingResumeVerification): Promise<boolean> {
  if (cfg.reloadStrategy !== 'auto') return (await reloadOnce($, aw, cfg.reloadStrategy, 'trimmed')) === 'ok'
  const learned = await readLearned($)
  if (learned !== 'clear-resume') {
    const first = await reloadOnce($, aw, 'direct', 'trimmed')
    if (first === 'ok') {
      await remember($, 'direct')
      return true
    }
    // Only a completed no-op escalates; an error or a hang points at the file, and /clear would
    // throw away a live conversation for nothing.
    if (first === 'failed') return false
    // The engine reports a failed resume as UI text with no error, so a failure looks like a no-op.
    // /clear is destructive: only attempt it if the file on disk is still what we wrote (a pipe, a
    // truncation or a replacement is not).
    if (!(await fileIsIntact($, aw))) {
      await debug($, 'not escalating to /clear: the transcript on disk is not what was written')
      return false
    }
  }
  // /resume of the open session did nothing: /clear then /resume always loads from disk.
  const ok = (await reloadOnce($, aw, 'clear-resume', 'trimmed')) === 'ok'
  if (ok) await remember($, 'clear-resume')
  return ok
}

/** Restore the backup over the transcript, re-trigger /resume once, and say what happened. */
async function rollback($: EngineInterface, aw: AwaitingResumeVerification): Promise<void> {
  await debug($, 'rollback start')
  await enterPhase($, 'rolling-back')
  let restored = false
  let detail = ''
  try {
    await restoreBackup($, aw.transcriptPath, aw.backupPath, platformOf(aw.transcriptPath, await $.env.get('OS')))
    restored = true
  } catch (err) {
    detail = ` The backup could not be restored automatically (${String(err)}); copy ${aw.backupPath} over ${aw.transcriptPath} by hand.`
  }
  if (restored && aw.retries < 1) {
    aw.retries += 1
    const ok = (await reloadOnce($, aw, 'direct', 'reverted')) !== 'failed'
    if (!ok) detail = ' The session could not be re-verified after the revert; if it looks wrong, run /clear then /resume.'
  }
  awaitingResumeVerification = undefined
  phase = 'idle'
  await debug($, `rollback done restored=${restored}${detail}`)
  if (aw.source === 'agent') {
    notify($, `${FAILURE_TEXT}${detail}`, `${FAILURE_TEXT} Your trim was NOT applied and your context is unchanged. Do not retry the trim; continue with your task.`)
  } else {
    notify($, `${FAILURE_TEXT}${detail}`, undefined)
    idleNotice = 'Flagged trims could not be applied while you were idle: the reload failed and was reverted. Your context is unchanged and those flags were dropped.'
  }
}

async function runRestoreJob($: EngineInterface): Promise<void> {
  try {
    const loc = await locateTranscript($)
    const path = loc?.path
    const id = await $.session.id()
    const backup = `${path}_trim-backup`
    if (!loc || !path || !(await $.fs.exists(backup))) {
      phase = 'idle'
      $.ui.log(`${PLUGIN}: no trim backup exists for this session.`)
      return
    }
    await restoreBackup($, path, backup, loc.platform)
    await $.command.run({ command: 'clear', args: '' })
    await $.command.run({ command: 'resume', args: id })
    phase = 'idle'
    $.ui.log(`${PLUGIN}: restored ${backup} and reloaded the session.`)
  } catch (err) {
    phase = 'idle'
    $.ui.log(`${PLUGIN}: restore failed: ${String(err)}`)
  }
}

