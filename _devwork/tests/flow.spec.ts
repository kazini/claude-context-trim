import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { BACKUP, FakeEngine, MiB, PATH, rowsToMessages, SESSION } from './fake-engine.ts'
import { chainProblems, pairing, parse, Transcript } from './fixtures.ts'

const QUEUED_RE = /^Session trim queued\. Finish your response now without calling further tools so the session can reload\./
const CONTINUE = 'Agent pruned context: success. Continue with your task.'
const FAILURE = 'Selective Context Trim failed to resume the trimmed session; reverted to the previous backup (.jsonl_trim-backup).'

/** Compare big strings without letting a failure print megabytes. */
function same(a: string, b: string, msg = 'files differ'): void {
  assert.ok(a === b, `${msg} (lengths ${a.length} vs ${b.length})`)
}

const blob = (n: number) => 'abcdefghi\n'.repeat(Math.round(n / 10))

/** An old Read, 12 small calls, then a big recent Bash: the shape of a burst of tool calls. */
function bigSession(opts: { old?: number; recent?: number; head?: number } = {}): Transcript {
  const t = new Transcript(SESSION)
  for (let i = 0; i < Math.round((opts.head ?? 0) / 10_000); i++) t.meta({ type: 'file-history-snapshot', snapshot: { blob: 'H'.repeat(10_000) } })
  t.user('refactor the parser')
  t.thinking('m0', 'read the old file')
  t.toolUse('m0', 'toolu_old', 'Read', { file_path: 'src/old.ts' })
  t.toolResult('toolu_old', blob(opts.old ?? 45_000))
  for (let i = 0; i < 12; i++) {
    t.toolUse(`mf${i}`, `toolu_f${i}`, 'Bash', { command: 'echo' })
    t.toolResult(`toolu_f${i}`, blob(2_000))
  }
  t.thinking('mr', 'run the suite')
  t.text('mr', 'Running the full suite.')
  t.toolUse('mr', 'toolu_recent', 'Bash', { command: 'npm test' })
  t.toolResult('toolu_recent', blob(opts.recent ?? 80_000))
  return t
}

async function ready(opts: { old?: number; recent?: number; head?: number; options?: Record<string, unknown>; tokens?: number; percent?: number } = {}) {
  const e = new FakeEngine(opts.options ?? {})
  e.load(bigSession(opts))
  if (opts.tokens !== undefined) e.contextTokens = opts.tokens
  if (opts.percent !== undefined) e.percent = opts.percent
  await e.start()
  return e
}

/** More work after a reload: the engine keeps appending to the same transcript. */
function cont(e: FakeEngine): Transcript {
  const rows = e.rows()
  const t = new Transcript(SESSION)
  ;(t as any).last = [...rows].reverse().find((r) => typeof r['uuid'] === 'string')?.['uuid'] ?? null
  ;(t as any).n = 5000 + rows.length
  return t
}

const RECENT = { tool_targets: [{ id: 'toolu_recent' }] }
const MIXED = { tool_targets: [{ id: 'toolu_recent' }], regex_rules: [{ pattern: 'abcdefghi\\n', mode: 'delete', scope_tool_ids: ['toolu_f11'] }] }

/** Agent trims are deferred by default; these tests exercise the explicit immediate path. */
const now = (args: Record<string, unknown>) => ({ force: true, ...args })

async function trim(e: FakeEngine, args: Record<string, unknown>, id = 'toolu_trim1') {
  const call = now(args)
  const r = await e.callTool('trim_session', call, id)
  assert.ok(r && 'result' in r, 'expected the trim to be queued: ' + JSON.stringify(r))
  assert.match(r.result, QUEUED_RE)
  await e.endTrimTurn(id, call)
  return r.result as string
}

function callText(e: FakeEngine, id: string): string | undefined {
  for (const m of rowsToMessages(e.memory)) for (const u of m.toolUses) if (u.tool_use_id === id) return u.text
  return undefined
}

describe('registration', () => {
  test('both tools and the restore command are registered, with model-facing instructions', async () => {
    const e = await ready()
    assert.deepEqual([...e.tools.keys()].sort(), ['inspect_session', 'trim_session'])
    const d = e.tools.get('trim_session')!['description'] as string
    for (const needle of ['Flagging is free', 'PENDING', 'WHEN TO FLAG', 'BEFORE FLAGGING', 'stub', 'summary', 'delete', 'regex_rules', 'scope_tool_ids', 'unflag', 'session_note', 'by itself']) assert.ok(d.includes(needle), needle)
    assert.deepEqual(e.commands, ['trim-restore'])
  })

  test('inspect_session returns ids and sizes and is read-only', async () => {
    const e = await ready()
    const before = e.text(PATH)
    const r = await e.callTool('inspect_session', {})
    assert.match(r.result, /toolu_recent/)
    assert.match(r.result, /Cache:/)
    assert.equal(e.text(PATH), before)
    assert.deepEqual(e.commandRuns, [])
  })
})

describe('happy path', () => {
  test('mixed call: queued, nothing touched mid-turn, then backup, rewrite, resume, continue', async () => {
    const e = await ready()
    const original = e.text(PATH)

    const args = now(MIXED)
    const r = await e.callTool('trim_session', args, 'toolu_trim1')
    assert.match(r.result, QUEUED_RE)
    same(e.text(PATH), original, 'no file edit while the turn is running')
    assert.equal(e.files.has(BACKUP), false)

    await e.endTrimTurn('toolu_trim1', args)
    const flushed = e.text(PATH) // original + the trim turn the engine appended
    await e.settle()

    assert.deepEqual(e.commandRuns, [`resume ${SESSION}`])
    same(e.text(BACKUP), flushed, 'the backup is the file exactly as it was before the rewrite')
    assert.ok(e.text(PATH) !== flushed)
    const lines = e.lines()
    assert.ok(lines.some((l) => l.includes('[Trimmed: 8,000 lines')))
    // the 80,000-char result is really gone from disk, and the regex rule emptied f11's result
    assert.ok(flushed.length - e.text(PATH).length > 75_000)
    assert.equal(callText(e, 'toolu_f11'), '[Trimmed: all content removed by regex_rules]')
    assert.deepEqual(chainProblems(lines), [])
    const p = pairing(lines)
    assert.deepEqual([...p.uses].sort(), [...p.results].sort())
    assert.deepEqual(e.prompts, [CONTINUE])
    assert.equal(callText(e, 'toolu_trim1'), 'Agent pruned context: success')
    // the engine now holds the trimmed conversation
    assert.match(callText(e, 'toolu_recent')!, /^\[Trimmed: 8,000 lines \/ 80,000 chars removed from Bash\(npm test\) \(toolu_recent\)\]$/)
  })

  test('never creates a second .jsonl for the session; backup ends in _trim-backup; no temp files left', async () => {
    const e = await ready()
    await trim(e, MIXED)
    await e.settle()
    const keys = [...e.files.keys()]
    assert.deepEqual(keys.filter((k) => k.endsWith('.jsonl')), [PATH])
    assert.deepEqual(keys.filter((k) => k.includes('_trim-backup')), [BACKUP])
    assert.deepEqual(keys.filter((k) => k.endsWith('.tmp')), [])
  })

  test('the rewrite is atomic: a temp file is renamed over the transcript', async () => {
    const e = await ready()
    await trim(e, RECENT)
    await e.settle()
    const mvs = e.processRuns.filter((a) => a[0] === 'mv')
    assert.ok(mvs.some((a) => a[3] === PATH && a[2] === PATH + '.trim-new.tmp'))
    assert.ok(mvs.some((a) => a[3] === BACKUP))
  })

  test('a custom session_note is kept and used in the continuation prompt', async () => {
    const e = await ready()
    await trim(e, { ...RECENT, session_note: 'Pruned the test log' })
    await e.settle()
    assert.equal(callText(e, 'toolu_trim1'), 'Pruned the test log')
    assert.deepEqual(e.prompts, ['Pruned the test log. Continue with your task.'])
  })

  test('a slow transcript flush is waited for', async () => {
    const e = await ready()
    const args = now(RECENT)
    const r = await e.callTool('trim_session', args, 'toolu_trim1')
    assert.match(r.result, QUEUED_RE)
    await e.endTrimTurn('toolu_trim1', args, undefined, { flushDelayMs: 700 })
    await e.settle()
    assert.deepEqual(e.prompts, [CONTINUE])
    assert.match(callText(e, 'toolu_recent')!, /Trimmed/)
  })
})

describe('privacy of the files it writes', () => {
  test('the rewritten transcript and the backup stay private (0600), never world-readable', async () => {
    const e = await ready()
    assert.equal(e.modes.get(PATH), '600')
    await trim(e, RECENT)
    await e.settle()
    assert.equal(e.modes.get(PATH), '600', 'transcript mode after the swap')
    assert.equal(e.modes.get(BACKUP), '600', 'backup mode')
  })

  test('the mode is tightened before the temp file replaces the real one', async () => {
    const e = await ready()
    await trim(e, RECENT)
    await e.settle()
    const order = e.processRuns.map((a) => a.slice(0, 3).join(' '))
    const chmodAt = order.indexOf(`chmod 600 ${PATH}.trim-new.tmp`)
    const mvAt = order.findIndex((x) => x.startsWith('mv -f') && x.endsWith(`${PATH}.trim-new.tmp`))
    assert.ok(chmodAt >= 0 && mvAt > chmodAt, `chmod at ${chmodAt}, mv at ${mvAt}`)
  })

  test('a restored transcript is private too', async () => {
    const e = await ready()
    e.failResumeIf = (text) => text.includes('Trimmed')
    await trim(e, RECENT)
    await e.settle()
    assert.equal(e.modes.get(PATH), '600')
  })
})

describe('single-slot backup across repeated trims', () => {
  test('each trim overwrites the one backup; only the latest is kept', async () => {
    const e = await ready()
    await trim(e, RECENT, 'toolu_trim1')
    const beforeFirst = e.text(PATH)
    await e.settle()
    const firstBackup = e.text(BACKUP)
    assert.equal(firstBackup, beforeFirst)

    // the agent carries on: another big result, then trims again
    const t = cont(e)
    t.toolUse('mx', 'toolu_new1', 'Bash', { command: 'npm run lint' }).toolResult('toolu_new1', blob(90_000))
    e.append(t)
    e.contextTokens = 80_000
    await trim(e, { tool_targets: [{ id: 'toolu_new1' }] }, 'toolu_trim2')
    const beforeSecond = e.text(PATH)
    await e.settle()

    same(e.text(BACKUP), beforeSecond)
    assert.ok(e.text(BACKUP) !== firstBackup)
    assert.deepEqual([...e.files.keys()].filter((k) => k.includes('_trim-backup')), [BACKUP])
    assert.equal(callText(e, 'toolu_trim2'), 'Agent pruned context: success')
    assert.match(callText(e, 'toolu_new1')!, /Trimmed/)
    assert.equal(e.prompts.length, 2)
  })
})

describe('resume verification, fallback and rollback', () => {
  test('a failing resume restores the backup, reloads once, and reports it', async () => {
    const e = await ready()
    e.failResumeIf = (text) => text.includes('[Trimmed')
    await trim(e, RECENT)
    const flushed = e.text(PATH)
    await e.settle()

    same(e.text(PATH), flushed, 'transcript restored byte-for-byte')
    same(e.text(BACKUP), flushed, 'the backup stays on disk')
    // one failed attempt on the trimmed file, one reload after the revert: never /clear, never a loop
    assert.deepEqual(e.commandRuns, [`resume ${SESSION}`, `resume ${SESSION}`])
    assert.ok(e.logs.some((l) => l.includes(FAILURE)))
    assert.equal(e.prompts.length, 1)
    assert.ok(e.prompts[0]!.startsWith(FAILURE))
    assert.match(e.prompts[0]!, /NOT applied/)
    assert.equal(e.pendingTimers, 0)
    assert.equal(await e.userPrompt('next'), undefined, 'prompts flow again afterwards')
  })

  test('a resume that never finishes is cut off by the watchdog (5s) and rolled back', async () => {
    const e = await ready()
    e.resumeMode = (n) => (n === 1 ? 'hang' : 'ok')
    await trim(e, RECENT)
    const flushed = e.text(PATH)
    const t0 = e.now
    await e.settle()
    same(e.text(PATH), flushed)
    assert.ok(e.now - t0 >= 5_000 && e.now - t0 < 9_000, `elapsed ${e.now - t0}`)
    assert.ok(e.prompts[0]!.startsWith(FAILURE))
    assert.deepEqual(e.commandRuns, [`resume ${SESSION}`, `resume ${SESSION}`])
  })

  test('rollback retries at most once, even if the revert cannot be confirmed', async () => {
    const e = await ready()
    e.resumeMode = () => 'throw'
    await trim(e, RECENT)
    await e.settle()
    assert.equal(e.commandRuns.length, 2)
    assert.ok(e.prompts[0]!.includes(FAILURE))
    assert.match(e.logs.join('\n'), /could not be re-verified|reverted/)
    assert.equal(e.pendingTimers, 0)
  })

  test('/resume of the open session doing nothing falls back to /clear then /resume, and remembers it', async () => {
    const e = await ready()
    e.resumeMode = (n) => (n === 1 ? 'noop' : 'ok')
    await trim(e, RECENT, 'toolu_trim1')
    await e.settle()
    assert.deepEqual(e.commandRuns, [`resume ${SESSION}`, 'clear', `resume ${SESSION}`])
    assert.equal(e.store.get('reloadStrategy'), 'clear-resume')
    assert.deepEqual(e.prompts, [CONTINUE])
    assert.match(callText(e, 'toolu_recent')!, /Trimmed/)

    // the next trim goes straight to the strategy that worked
    const t = cont(e)
    t.toolUse('mx', 'toolu_new1', 'Bash', { command: 'make' }).toolResult('toolu_new1', blob(90_000))
    e.append(t)
    e.contextTokens = 80_000
    e.commandRuns.length = 0
    e.resumeMode = () => 'ok'
    await trim(e, { tool_targets: [{ id: 'toolu_new1' }] }, 'toolu_trim2')
    await e.settle()
    assert.deepEqual(e.commandRuns, ['clear', `resume ${SESSION}`])
  })

  test('a resume that reports failure as TEXT is a failure, not a no-op: never escalates to /clear', async () => {
    const e = await ready()
    e.resumeMode = (n) => (n === 1 ? 'notfound' : 'ok')
    await trim(e, RECENT)
    await e.settle()
    assert.ok(!e.commandRuns.includes('clear'), `ran: ${e.commandRuns.join(', ')}`)
    assert.deepEqual(e.commandRuns, [`resume ${SESSION}`, `resume ${SESSION}`])
    assert.ok(e.prompts[0]!.startsWith(FAILURE))
    assert.notEqual(e.store.get('reloadStrategy'), 'clear-resume')
  })

  test('a failed resume that LOOKS like a no-op never reaches /clear when the file is no longer what was written', async () => {
    const e = await ready()
    // the engine prints "No conversations found" but returns nothing, and the file has been replaced
    e.resumeMode = (n) => {
      if (n === 1) e.files.set(PATH, '')
      return 'noop'
    }
    await trim(e, RECENT)
    await e.settle()
    assert.ok(!e.commandRuns.includes('clear'), `ran: ${e.commandRuns.join(', ')}`)
    assert.ok(e.prompts[0]!.startsWith(FAILURE))
    assert.ok(e.text(PATH).length > 0, 'the backup was restored over the empty file')
  })

  test('a resume that prints something benign and changes nothing is still the no-op fallback', async () => {
    const e = await ready()
    e.resumeMode = (n) => (n === 1 ? 'noop' : 'ok')
    await trim(e, RECENT)
    await e.settle()
    assert.deepEqual(e.commandRuns, [`resume ${SESSION}`, 'clear', `resume ${SESSION}`])
  })

  test('prompts typed during the reload are held back, then flow again', async () => {
    const e = await ready()
    e.resumeMode = (n) => (n === 1 ? 'hang' : 'ok')
    await trim(e, RECENT)
    await e.settle(1_500)
    const held = await e.userPrompt('hello?')
    assert.ok(held && 'drop' in held)
    assert.ok(e.toasts.length > 0)
    await e.settle()
    assert.equal(await e.userPrompt('hello again'), undefined)
  })

  test('/trim-restore puts the backup back and reloads', async () => {
    const e = await ready()
    await trim(e, RECENT)
    const flushed = e.text(PATH)
    await e.settle()
    assert.ok(e.text(PATH) !== flushed)
    const r = await e.emit('command.run', { command: 'trim-restore' })
    assert.match(r.text, /Restoring/)
    await e.settle()
    same(e.text(PATH), flushed)
    assert.ok(e.commandRuns.includes('clear'))
  })
})

describe('hooks that throw answer through .catch', () => {
  test('a crash inside trim_session becomes a clear refusal, not a skipped hook', async () => {
    const e = await ready()
    e.$['session'].id = async () => {
      throw new Error('boom')
    }
    const r = await e.callTool('trim_session', RECENT)
    assert.match(r.deny, /internal error; nothing was changed/)
  })

  test('a crash inside inspect_session becomes a clear refusal too', async () => {
    const e = await ready()
    e.$['session'].messages = async () => {
      throw new Error('boom')
    }
    const r = await e.callTool('inspect_session', {})
    assert.ok(r && ('deny' in r || 'result' in r))
  })

  test('the prompt guard fails OPEN: a bug in it never swallows the user\'s prompt', async () => {
    const e = await ready()
    await trim(e, RECENT) // phase is now `applying`, so the guard has to consult the clock
    e.$['clock'].now = async () => {
      throw new Error('boom')
    }
    assert.equal(await e.userPrompt('hello'), undefined)
  })
})

describe('finding the transcript (no $.session.info on 2.1.318)', () => {
  test('the path reported by classic events is used', async () => {
    const e = await ready()
    await trim(e, RECENT)
    await e.settle()
    assert.deepEqual(e.prompts, [CONTINUE])
  })

  test('without a classic event the standard location is computed and checked', async () => {
    const e = new FakeEngine()
    e.reportTranscript = false
    e.load(bigSession())
    await e.start()
    await trim(e, RECENT)
    await e.settle()
    assert.deepEqual(e.prompts, [CONTINUE])
    // CLAUDE_CONFIG_DIR wins over HOME
    const f = new FakeEngine()
    f.reportTranscript = false
    f.env = { CLAUDE_CONFIG_DIR: '/home/u/.claude', HOME: '/nowhere' }
    f.load(bigSession())
    await f.start()
    assert.match((await f.callTool('trim_session', now(RECENT))).result, QUEUED_RE)
  })

  test('a classic event for another session is ignored', async () => {
    const e = new FakeEngine()
    e.reportTranscript = false
    e.load(bigSession())
    await e.start()
    await e.emit('classic.UserPromptSubmit', { session_id: 'some-other-session', transcript_path: '/elsewhere/other.jsonl' })
    await trim(e, RECENT)
    await e.settle()
    assert.deepEqual(e.prompts, [CONTINUE])
  })

  test('if the file cannot be found the trim is refused at call time, before the agent ends its turn', async () => {
    const e = new FakeEngine()
    e.reportTranscript = false
    e.env = { HOME: '/somewhere/else' }
    e.load(bigSession())
    await e.start()
    const r = await e.callTool('trim_session', RECENT)
    assert.match(r.deny, /transcript file could not be located/)
  })
})

describe('abort paths leave the transcript alone', () => {
  test('an aborted turn discards the queued trim', async () => {
    const e = await ready()
    const original = e.text(PATH)
    const args = now(RECENT)
    const r = await e.callTool('trim_session', args, 'toolu_trim1')
    assert.match(r.result, QUEUED_RE)
    await e.endTrimTurn('toolu_trim1', args, undefined, { reason: 'aborted' })
    const flushed = e.text(PATH)
    await e.settle()
    same(e.text(PATH), flushed)
    assert.ok(flushed !== original)
    assert.deepEqual(e.commandRuns, [])
    assert.equal(e.files.has(BACKUP), false)
    assert.ok(e.logs.some((l) => l.includes('discarded')))
  })

  test('a new turn starting while the trim is prepared cancels it (and the agent is told)', async () => {
    const e = await ready()
    await trim(e, RECENT)
    const flushed = e.text(PATH)
    await e.emit('turn.start', {})
    await e.settle()
    same(e.text(PATH), flushed)
    assert.equal(e.files.has(BACKUP), false)
    assert.deepEqual(e.commandRuns, [])
    assert.match(e.prompts[0]!, /aborted: a new turn started/)
  })

  test('a request whose targets are missing from the transcript changes nothing and says so', async () => {
    const e = await ready()
    // present in the engine's view, but not in the file (e.g. compacted away on disk)
    const args = now({ tool_targets: [{ id: 'toolu_recent' }] })
    const r = await e.callTool('trim_session', args, 'toolu_trim1')
    assert.match(r.result, QUEUED_RE)
    e.files.set(PATH, e.lines().filter((l) => !l.includes('toolu_recent')).join('\n') + '\n')
    await e.endTrimTurn('toolu_trim1', args)
    const flushed = e.text(PATH)
    await e.settle()
    same(e.text(PATH), flushed)
    assert.match(e.prompts[0]!, /Session trim aborted/)
  })

  test('a request that matches in the engine\'s view but nothing on disk makes no changes and no reload', async () => {
    const e = await ready()
    const args = now({ regex_rules: [{ pattern: 'abcdefghi\\n', mode: 'delete', scope_tool_ids: ['toolu_recent'] }] })
    const r = await e.callTool('trim_session', args, 'toolu_trim1')
    assert.match(r.result, QUEUED_RE) // priced on the engine's copy, which still has the text
    // on disk that result no longer contains the pattern
    e.files.set(PATH, e.lines().map((l) => (l.includes('"tool_use_id":"toolu_recent"') ? l.replaceAll('abcdefghi\\n', 'zzz') : l)).join('\n') + '\n')
    await e.endTrimTurn('toolu_trim1', args)
    const flushed = e.text(PATH)
    await e.settle()
    same(e.text(PATH), flushed)
    assert.equal(e.files.has(BACKUP), false)
    assert.deepEqual(e.commandRuns, [])
    assert.match(e.prompts[0]!, /no changes: nothing matched/)
  })
})

/** A model turn as the engine sees it: start, a request, the body, end. */
async function inTurn(e: FakeEngine, body: () => Promise<void>, reason = 'answer'): Promise<void> {
  await e.emit('turn.start', {})
  await e.step()
  await body()
  await e.emit('turn.complete', { reason })
}

const OLD = { tool_targets: [{ id: 'toolu_old' }] }
const MIN = 60_000

describe('guards: flag, queue, or wait (nobody is ever asked)', () => {
  test('invalid input is refused immediately and nothing is flagged or queued', async () => {
    const e = await ready()
    for (const [args, re] of [
      [{ regex_rules: [{ pattern: '(' }] }, /invalid regular expression/],
      [{ regex_rules: [{ pattern: 'a', mode: 'summary' }] }, /requires a non-empty "replacement"/],
      [{ tool_targets: [{ id: 'toolu_nope_x' }] }, /not found among the \d+ most recent messages/],
      [{}, /Nothing to flag/],
    ] as const) {
      const r = await e.callTool('trim_session', args as any, 'toolu_trim1')
      assert.ok('deny' in r, JSON.stringify(args))
      assert.match(r.deny, re)
    }
    await e.emit('turn.complete', { reason: 'answer' })
    await e.settle()
    assert.deepEqual(e.commandRuns, [])
    assert.equal(e.files.has(BACKUP), false)
  })

  test('a paying result still waits by default: deferral is the rule, force is the exception', async () => {
    const e = await ready()
    const pending = await e.callTool('trim_session', RECENT, 'toolu_trim1')
    assert.match(pending.result, /^Flagged\./)
    assert.doesNotMatch(pending.result, /Session trim queued/)
    const forced = await e.callTool('trim_session', now(RECENT), 'toolu_trim2')
    assert.match(forced.result, QUEUED_RE)
    assert.match(forced.result, /saves ≈/)
  })

  test('a small result is simply flagged: pending, not refused', async () => {
    const e = await ready()
    const r = await e.callTool('trim_session', { tool_targets: [{ id: 'toolu_f3' }] }, 'toolu_trim1')
    assert.ok('result' in r)
    assert.match(r.result, /^Flagged\. 1 item\(s\) pending/)
    assert.match(r.result, /No action needed/)
    assert.doesNotMatch(r.result, /Session trim queued/)
    await e.emit('turn.complete', { reason: 'answer' })
    await e.settle(2 * MIN)
    assert.deepEqual(e.commandRuns, [], 'nothing was applied')
    assert.equal(e.asked.length, 0)
  })

  test('force pushes a tiny flag through now', async () => {
    const e = await ready()
    const r = await e.callTool('trim_session', { tool_targets: [{ id: 'toolu_f3' }], force: true }, 'toolu_trim1')
    assert.match(r.result, QUEUED_RE)
  })

  test('an old deep result waits, even with force; there is no dialog', async () => {
    const e = await ready()
    const r = await e.callTool('trim_session', OLD, 'toolu_trim1')
    assert.match(r.result, /^Flagged\./)
    const forced = await e.callTool('trim_session', { ...OLD, force: true }, 'toolu_trim2')
    assert.match(forced.result, /stays pending even with force/)
    assert.equal(e.asked.length, 0)
  })

  test('a marginal set is flagged; force queues it', async () => {
    const e = await ready({ old: 90_000 })
    const r = await e.callTool('trim_session', OLD, 'toolu_trim1')
    assert.match(r.result, /^Flagged\./)
    assert.match((await e.callTool('trim_session', { ...OLD, force: true }, 'toolu_trim2')).result, QUEUED_RE)
  })

  test('context pressure relaxes one step', async () => {
    const e = await ready({ old: 90_000, percent: 90 })
    assert.match((await e.callTool('trim_session', now(OLD))).result, QUEUED_RE)
  })

  test('a deliberate cross-history batch is judged on its long-term numbers', async () => {
    const e = await ready({ old: 90_000, recent: 90_000, tokens: 90_000 })
    const ids = ['toolu_old', 'toolu_recent', ...Array.from({ length: 12 }, (_, i) => `toolu_f${i}`)]
    const r = await e.callTool('trim_session', now({ tool_targets: ids.map((id) => ({ id })), expected_remaining_requests: 40 }), 'toolu_trim1')
    assert.match(r.result, QUEUED_RE)
  })

  test('an expired cache lifts the penalty: the deep flag that waits when warm goes through when cold', async () => {
    const warm = await ready()
    await warm.step()
    assert.match((await warm.callTool('trim_session', OLD)).result, /^Flagged\./)
    const cold = await ready()
    await cold.step()
    cold.now += 10 * MIN
    const r = await cold.callTool('trim_session', now(OLD))
    assert.match(r.result, QUEUED_RE)
    assert.match(r.result, /already expired/)
  })

  test('the cache lifetime is learned from the API usage (1h writes cost 2x)', async () => {
    const e = await ready()
    await e.step({ usage: { cache_creation_input_tokens: 5000, ephemeral_1h_input_tokens: 5000, ephemeral_5m_input_tokens: 0 } })
    assert.match((await e.callTool('trim_session', RECENT)).result, /recomputed at 2x/)
    const e2 = await ready()
    await e2.step({ usage: { cache_creation_input_tokens: 5000, ephemeral_5m_input_tokens: 5000 } })
    assert.match((await e2.callTool('trim_session', RECENT)).result, /recomputed at 1\.25x/)
  })

  test('a cache that survives a long gap means the long lifetime', async () => {
    const e = await ready()
    await e.step()
    e.now += 7 * MIN
    await e.step({ usage: { cache_read_input_tokens: 50_000, cache_creation_input_tokens: 100 } })
    assert.match((await e.callTool('trim_session', RECENT)).result, /recomputed at 2x/)
  })

  test('subagents may not use the tools', async () => {
    const e = await ready()
    assert.match((await e.callTool('trim_session', { ...RECENT, agentId: 'agent-1' })).deny, /main conversation/)
    assert.match((await e.callTool('inspect_session', { agentId: 'agent-1' })).deny, /main conversation/)
  })

  test('main-thread steps stamp the cache clock; a subagent step does not', async () => {
    const e = await ready()
    await e.step({ agentId: 'sub' })
    assert.match((await e.callTool('inspect_session', {})).result, /age unknown/)
    await e.step()
    assert.match((await e.callTool('inspect_session', {})).result, /last used 0s ago/)
  })
})

describe('flags', () => {
  test('a recent flag is not held back by an older pending one: the best subset applies, the rest waits', async () => {
    const e = await ready()
    assert.match((await e.callTool('trim_session', OLD, 'toolu_trim1')).result, /^Flagged\./)
    const r = await e.callTool('trim_session', now(RECENT), 'toolu_trim2')
    assert.match(r.result, QUEUED_RE)
    assert.match(r.result, /1 other flagged item\(s\) stay pending/)
    await e.endTrimTurn('toolu_trim2', now(RECENT))
    await e.settle(30_000)
    assert.match(callText(e, 'toolu_recent')!, /^\[Trimmed/)
    assert.doesNotMatch(callText(e, 'toolu_old')!, /^\[Trimmed/, 'the old one was left alone')
    const listed = await e.callTool('trim_session', { list: true }, 'toolu_trim3')
    assert.match(listed.result, /toolu_old/)
  })

  test('unflag and list', async () => {
    const e = await ready()
    await e.callTool('trim_session', OLD, 'toolu_trim1')
    const listed = await e.callTool('trim_session', { list: true }, 'toolu_trim2')
    assert.match(listed.result, /Pending 1 item\(s\)/)
    assert.match(listed.result, /f1 stub toolu_old/)
    assert.match((await e.callTool('trim_session', { unflag: ['f1'] }, 'toolu_trim3')).result, /Unflagged 1/)
    assert.match((await e.callTool('trim_session', { list: true }, 'toolu_trim4')).result, /No flagged items are pending/)
    assert.match((await e.callTool('trim_session', { unflag: ['toolu_zzz'] }, 'toolu_trim5')).result, /Nothing matched/)
    // flagging the same result again replaces the earlier flag (the agent changed its mind about the mode)
    const firstOverride = await e.callTool('trim_session', { tool_targets: [{ id: 'toolu_old', mode: 'summary', replacement: 'first' }] }, 'toolu_trim6')
    assert.match(String(firstOverride.result), /^Flagged\./)
    const secondOverride = await e.callTool('trim_session', { tool_targets: [{ id: 'toolu_old', mode: 'summary', replacement: 'second' }] }, 'toolu_trim7')
    assert.equal(secondOverride.result, '', 'a duplicate re-flag is silent')
    const again = (await e.callTool('trim_session', { list: true }, 'toolu_trim8')).result as string
    assert.match(again, /second/)
    assert.doesNotMatch(again, /first/)
    assert.equal(again.match(/f\d+ summary toolu_old/g)?.length, 1, 'one flag, overridden in place')
  })

  test('at the end of a turn what now pays off is applied, with no prompt to the agent, and it is told once afterwards', async () => {
    const e = await ready({ old: 90_000 })
    await inTurn(e, async () => {
      assert.match((await e.callTool('trim_session', OLD)).result, /^Flagged\./) // marginal now
      e.percent = 90 // context fills up while the agent works: it now pays off
    })
    await e.settle(30_000)
    assert.deepEqual(e.commandRuns, [`resume ${SESSION}`])
    assert.deepEqual(e.prompts, [], 'an idle agent is never prompted')
    assert.match(callText(e, 'toolu_old')!, /^\[Trimmed/)
    const first = await e.classic('UserPromptSubmit')
    assert.match(first.additionalContext[0], /While you were idle, 1 result\(s\) you flagged were trimmed/)
    assert.equal((await e.classic('UserPromptSubmit'))?.additionalContext, undefined, 'only once')
    assert.equal(e.asked.length, 0)
  })

  test('cold cache: pending flags are applied while idle, for free', async () => {
    const e = await ready()
    await inTurn(e, async () => {
      assert.match((await e.callTool('trim_session', OLD)).result, /^Flagged\./)
    })
    await e.settle(2 * MIN)
    assert.deepEqual(e.commandRuns, [], 'still warm: nothing happens')
    assert.ok(e.pendingTimers > 0, 'the cold-cache timer is armed')
    await e.settle(10 * MIN) // settle() runs to the last timer inside the window, not to its end
    assert.deepEqual(e.commandRuns, [`resume ${SESSION}`])
    assert.deepEqual(e.prompts, [])
    assert.match(callText(e, 'toolu_old')!, /^\[Trimmed/)
    assert.match((await e.classic('UserPromptSubmit')).additionalContext[0], /While you were idle/)
    assert.ok(e.logs.some((l) => l.includes('prompt cache had expired')))
  })

  test('the cold-cache timer waits for the real expiry, and a flag that is not worth a reload is left alone', async () => {
    const e = await ready()
    await inTurn(e, async () => {
      await e.callTool('trim_session', { tool_targets: [{ id: 'toolu_f3' }] })
    })
    await e.settle(10 * MIN)
    assert.deepEqual(e.commandRuns, [], 'a 570-token result is not worth a reload even when free')
    assert.equal(e.pendingTimers, 0, 'and it does not spin')
  })

  test('a regex flag pinned to a result waits and is verified like any other', async () => {
    const e = await ready()
    const args = { regex_rules: [{ pattern: '(?:abcdefghi\\n)+', scope_tool_ids: ['toolu_old'], mode: 'stub' }] }
    await inTurn(e, async () => {
      assert.match((await e.callTool('trim_session', args)).result, /^Flagged\./)
    })
    await e.settle(8 * MIN)
    assert.deepEqual(e.commandRuns, [`resume ${SESSION}`])
    assert.match(callText(e, 'toolu_old')!, /^\[Trimmed: .* lines \/ .* chars matched\]/)
  })

  test('a per-line stub rule that would GROW the text is explained, not silently ignored', async () => {
    const e = await ready()
    const r = await e.callTool('trim_session', { regex_rules: [{ pattern: 'abcdefghi\\n', scope_tool_ids: ['toolu_old'], mode: 'stub' }] })
    assert.match(r.deny, /each match is shorter than its replacement/)
  })

  test('an unscoped regex cannot wait', async () => {
    const e = await ready()
    const r = await e.callTool('trim_session', { regex_rules: [{ pattern: 'f3 L00\\d\\d lorem', mode: 'delete' }] })
    assert.ok('deny' in r || /unscoped/i.test(r.result), JSON.stringify(r).slice(0, 300))
  })

  test('a failed idle application tells the agent with its next prompt, not by prompting it', async () => {
    const e = await ready()
    e.failResumeIf = (text) => text.includes('[Trimmed')
    await inTurn(e, async () => {
      await e.callTool('trim_session', OLD)
    })
    await e.settle(8 * MIN)
    assert.deepEqual(e.prompts, [])
    assert.ok(e.logs.some((l) => l.includes(FAILURE)))
    assert.match((await e.classic('UserPromptSubmit')).additionalContext[0], /could not be applied while you were idle/)
    assert.doesNotMatch(callText(e, 'toolu_old')!, /^\[Trimmed/, 'the original was restored')
  })

  test('a turn that was cut short does not trigger an application', async () => {
    const e = await ready()
    await inTurn(e, async () => {
      await e.callTool('trim_session', OLD)
    }, 'aborted')
    await e.settle(30_000)
    assert.deepEqual(e.commandRuns, [])
  })
})

describe('flags: edge cases found by mutation testing', () => {
  test('a timer that fires while the cache is still warm (something touched it meanwhile) waits for the real expiry', async () => {
    const e = await ready()
    await inTurn(e, async () => {
      await e.callTool('trim_session', OLD)
    })
    e.now += 200_000
    await e.step() // a request touches the cache at t=200s without any turn event: the armed timer is now too early
    await e.settle(5 * MIN) // reaches the original due time (~303s): age is only ~103s
    assert.deepEqual(e.commandRuns, [], 'not applied while warm')
    assert.ok(e.pendingTimers > 0, 're-armed for the real expiry')
    await e.settle(20 * MIN)
    assert.deepEqual(e.commandRuns, [`resume ${SESSION}`])
  })

  test('an idle application that cannot be done is reported with the next prompt, never by prompting the agent', async () => {
    const e = await ready()
    await inTurn(e, async () => {
      await e.callTool('trim_session', OLD)
    })
    // the flagged result is gone from the file on disk (e.g. rewritten elsewhere) while the engine still shows it
    e.files.set(PATH, e.lines().filter((l) => !l.includes('toolu_old')).join('\n') + '\n')
    const before = e.text(PATH)
    await e.settle(20 * MIN)
    assert.deepEqual(e.prompts, [])
    assert.deepEqual(e.commandRuns, [])
    same(e.text(PATH), before, 'the transcript is untouched')
    assert.match((await e.classic('UserPromptSubmit')).additionalContext[0], /Session trim aborted/)
  })

  test('a subagent\'s prompt cannot consume the main agent\'s one-time notice', async () => {
    const e = await ready({ old: 90_000 })
    await inTurn(e, async () => {
      await e.callTool('trim_session', OLD)
      e.percent = 90
    })
    await e.settle(30_000)
    assert.equal((await e.classic('UserPromptSubmit', { agent_id: 'sub' }))?.additionalContext, undefined)
    assert.match((await e.classic('UserPromptSubmit')).additionalContext[0], /While you were idle/)
  })
})

describe('hints and permissions', () => {
  const post = (e: FakeEngine, extra: Record<string, unknown> = {}) =>
    e.classic('PostToolUse', { tool_name: 'Read', tool_use_id: 'toolu_x1', tool_response: 'x'.repeat(40_000), ...extra })

  test('a large result gets one short hint with its id; small ones, our own tools and subagents get none', async () => {
    const e = await ready()
    const out = await post(e)
    assert.match(out.additionalContext[0], /About|about \d+(\.\d+)?k tokens \(tool_use_id toolu_x1\)/)
    assert.match(out.additionalContext[0], /flagging is free/)
    assert.equal((await post(e))?.additionalContext, undefined, 'throttled')
    assert.equal((await post(e, { tool_response: 'tiny' }))?.additionalContext, undefined)
    assert.equal((await post(e, { tool_name: 'mcp__selective-context-trim__inspect_session' }))?.additionalContext, undefined)
    assert.equal((await post(e, { agent_id: 'sub' }))?.additionalContext, undefined)
  })

  test('hints can be switched off', async () => {
    const e = new FakeEngine({ nudges: false })
    e.load(bigSession())
    await e.start()
    assert.equal((await post(e))?.additionalContext, undefined)
  })

  test('a standing note appears at startup only, not on the reloads a trim causes', async () => {
    const e = new FakeEngine()
    e.load(bigSession())
    await e.emit('session.start', {})
    assert.match((await e.classic('SessionStart', { source: 'startup' })).additionalContext[0], /trim_session/)
    assert.equal((await e.classic('SessionStart', { source: 'resume' }))?.additionalContext, undefined)
  })

  test('only this plugin\'s two tools are pre-approved, and only when enabled', async () => {
    const e = await ready()
    for (const name of ['inspect_session', 'trim_session']) {
      assert.deepEqual((await e.classic('PermissionRequest', { tool_name: `mcp__selective-context-trim__${name}` })).decision, { behavior: 'allow' })
    }
    assert.equal((await e.classic('PermissionRequest', { tool_name: 'Bash' })), undefined)
    assert.equal((await e.classic('PermissionRequest', { tool_name: 'mcp__other__trim_session' })), undefined)
    const off = new FakeEngine({ autoAllowTools: false })
    await off.start()
    assert.equal(await off.classic('PermissionRequest', { tool_name: 'mcp__selective-context-trim__trim_session' }), undefined)
  })

  test('the user is never asked anything, on any path', async () => {
    const e = await ready()
    await e.callTool('trim_session', OLD, 'toolu_trim1')
    await e.callTool('trim_session', { ...OLD, force: true }, 'toolu_trim2')
    await trim(e, RECENT, 'toolu_trim3')
    await e.settle(8 * MIN)
    assert.equal(e.asked.length, 0)
    assert.ok(![...e.tools.values()].some((t) => /user/i.test(String(t['description']).replace(/user's|users|"user"\/"assistant"/gi, ''))), 'no tool text mentions a human gate')
  })
})



describe('large transcripts (the 4 MiB $.fs limit)', () => {
  test('only the tail is read, and the head is spliced back unchanged', async () => {
    const e = await ready({ head: 4.3 * MiB })
    assert.ok(e.text(PATH).length > 4 * MiB)
    const original = e.text(PATH)
    await trim(e, RECENT)
    const flushed = e.text(PATH)
    await e.settle() // the fake throws if the plugin ever reads or writes more than 4 MiB at once

    assert.ok(e.processRuns.some((a) => a[0] === 'tail'), 'the tail was read with tail -c (no ranged $.fs.read)')
    assert.ok(e.processRuns.some((a) => a[0] === 'sh'), 'spliced with head/cat')
    same(e.text(BACKUP), flushed)
    const after = e.text(PATH)
    assert.ok(after.length < flushed.length)
    // everything before the first changed line is byte-identical
    same(after.slice(0, 4_000_000), original.slice(0, 4_000_000), 'head changed')
    assert.deepEqual(chainProblems(after.split('\n').filter(Boolean)), [])
    assert.match(callText(e, 'toolu_recent')!, /Trimmed/)
    assert.deepEqual(e.prompts, [CONTINUE])
  })

  test('on Windows a large transcript is declined cleanly instead of risking a bad write', async () => {
    const e = await ready({ head: 4.3 * MiB })
    e.env = { HOME: '/home/u', OS: 'Windows_NT' }
    await trim(e, RECENT)
    const flushed = e.text(PATH)
    await e.settle()
    same(e.text(PATH), flushed)
    assert.equal(e.files.has(BACKUP), false)
    assert.match(e.prompts[0]!, /not supported on Windows/)
  })
})
