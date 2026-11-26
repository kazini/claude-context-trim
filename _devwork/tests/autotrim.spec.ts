import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { FakeEngine, rowsToMessages, SESSION } from './fake-engine.ts'
import { TRIM_TOOL, Transcript } from './fixtures.ts'

const INSPECT_TOOL = 'mcp__selective-context-trim__inspect_session'
const MIN = 60_000
const blob = (n: number) => 'abcdefghi\n'.repeat(Math.round(n / 10))
const distinct = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `export function ${tag}Handler${i}(input: Payload${i}): Result${i} { return transform(input, ${(i * 7919) % 1013}) }`).join('\n')
const edit = (text: string, every: number, at = 3) => text.split('\n').map((l, i) => (i % every === at ? `${l} // edited` : l)).join('\n')
const numbered = (text: string) => text.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n')

const P = distinct(300, 'p')

/** Read src/p.ts, other work, edit it, read it again (the second read is the one that stays). */
function versions(): Transcript {
  const t = new Transcript(SESSION)
  t.user('refactor the parser')
  t.toolUse('m1', 'toolu_v1', 'Read', { file_path: 'src/p.ts' })
  t.toolResult('toolu_v1', numbered(P))
  for (let i = 0; i < 4; i++) {
    t.toolUse(`mf${i}`, `toolu_f${i}`, 'Bash', { command: `echo ${i}` })
    t.toolResult(`toolu_f${i}`, blob(2_000))
  }
  t.toolUse('m9', 'toolu_v2', 'Read', { file_path: 'src/p.ts' })
  t.toolResult('toolu_v2', numbered(edit(P, 8)))
  return t
}

/** One file, and the same text copied through another tool with every other line changed: alike, but not a copy. */
function overlapping(): Transcript {
  const t = new Transcript(SESSION)
  t.user('compare')
  t.toolUse('m1', 'toolu_a', 'Read', { file_path: 'src/a.ts' })
  t.toolResult('toolu_a', numbered(distinct(400, 'a')))
  t.toolUse('m2', 'toolu_b', 'Bash', { command: 'cat generated.ts' })
  t.toolResult('toolu_b', numbered(edit(distinct(400, 'a'), 2, 0)))
  return t
}

async function boot(t: Transcript, options: Record<string, unknown> = {}) {
  const e = new FakeEngine(options)
  e.load(t)
  await e.start()
  return e
}

const big = { tool_name: 'Read', tool_response: 'x'.repeat(30_000) }
const post = (e: FakeEngine, id: string, extra: Record<string, unknown> = {}) => e.classic('PostToolUse', { ...big, tool_use_id: id, ...extra })
const listing = async (e: FakeEngine) => String((await e.callTool('trim_session', { list: true }, 'toolu_list')).result)
const callText = (e: FakeEngine, id: string) => {
  for (const m of rowsToMessages(e.memory)) for (const u of m.toolUses) if (u.tool_use_id === id) return u.text
  return undefined
}
const mentions = (e: FakeEngine, id: string) => JSON.stringify(e.rows()).includes(id)

describe('automatic flagging of redundant older copies', () => {
  test('a re-read file flags the OLD read; the cold-cache pass then replaces it with a pointer, and the new read is untouched', async () => {
    const e = await boot(versions())
    assert.doesNotMatch(await listing(e), /auto:/, 'nothing is flagged before a big result arrives')
    await post(e, 'toolu_v2')
    assert.match(await listing(e), /auto: toolu_v1 superseded by newer toolu_v2/)

    await e.settle(10 * MIN)
    assert.deepEqual(e.commandRuns, [`resume ${SESSION}`], 'one reload, with no agent involved')
    assert.deepEqual(e.prompts, [], 'an idle agent is never prompted')
    assert.match(callText(e, 'toolu_v1')!, /^\[Trimmed — Summary: superseded by newer Read\(src\/p\.ts\) \(toolu_v2\), which holds the current content\]$/)
    assert.equal(callText(e, 'toolu_v2'), numbered(edit(P, 8)), 'the newer copy is never touched')
    const told = (await e.classic('UserPromptSubmit')).additionalContext[0]
    assert.match(told, /While you were idle, 1 redundant older copy that newer results supersede were trimmed/)
    assert.equal((await e.classic('UserPromptSubmit'))?.additionalContext, undefined, 'told once')
  })

  test('the agent can veto an automatic flag, and it is not made again', async () => {
    const e = await boot(versions())
    await post(e, 'toolu_v2')
    assert.match(String((await e.callTool('trim_session', { unflag: ['toolu_v1'] }, 'toolu_u1')).result), /Unflagged 1/)
    await post(e, 'toolu_v2b')
    await post(e, 'toolu_v2c')
    assert.doesNotMatch(await listing(e), /auto:/)
    await e.settle(10 * MIN)
    assert.deepEqual(e.commandRuns, [])
    assert.doesNotMatch(callText(e, 'toolu_v1')!, /^\[Trimmed/)
  })

  test('flagging the newer copy by hand cancels the automatic flag that pointed at it', async () => {
    const e = await boot(versions())
    await post(e, 'toolu_v2')
    const r = await e.callTool('trim_session', { tool_targets: [{ id: 'toolu_v2' }] }, 'toolu_h1')
    const text = String(r.result)
    assert.doesNotMatch(text, /auto: toolu_v1/, 'the old copy must not be trimmed once its replacement is going away')
  })

  test('the option can be switched off', async () => {
    const e = await boot(versions(), { autoFlag: false })
    await post(e, 'toolu_v2')
    assert.doesNotMatch(await listing(e), /auto:/)
    await e.settle(10 * MIN)
    assert.deepEqual(e.commandRuns, [])
  })

  test('unrelated results are never flagged, however big', async () => {
    const t = new Transcript(SESSION)
    t.user('read things')
    for (const [i, tag] of ['alpha', 'beta', 'gamma', 'delta'].entries()) {
      t.toolUse(`m${i}`, `toolu_r${i}`, 'Read', { file_path: `src/${tag}.ts` })
      t.toolResult(`toolu_r${i}`, numbered(distinct(300, tag)))
    }
    const e = await boot(t)
    await post(e, 'toolu_r3')
    assert.doesNotMatch(await listing(e), /auto:/)
  })
})

describe('the one-time heads-up for uncertain overlaps', () => {
  const notices = (out: { additionalContext?: string[] } | undefined) => (out?.additionalContext ?? []).filter((s) => /Possible overlap worth a look/.test(s))

  test('big but uncertain overlaps are mentioned ONCE, with ids, and never flagged by themselves', async () => {
    const e = await boot(overlapping())
    const first = notices(await post(e, 'toolu_b', { tool_name: 'Bash' }))
    assert.equal(first.length, 1)
    assert.match(first[0]!, /toolu_a \(Read\(src\/a\.ts\)\).*← toolu_b \(Bash\(cat generated\.ts\)\)/)
    assert.match(first[0]!, /mentioned only once/)
    assert.equal(notices(await post(e, 'toolu_b2', { tool_name: 'Bash' })).length, 0, 'only once')
    assert.equal(notices(await post(e, 'toolu_b3', { tool_name: 'Bash' })).length, 0)
    assert.doesNotMatch(await listing(e), /auto:/, 'a mention is not a flag')
  })

  test('hints off means no heads-up either', async () => {
    const e = await boot(overlapping(), { nudges: false })
    assert.equal(notices(await post(e, 'toolu_b', { tool_name: 'Bash' })).length, 0)
  })

  test('inspect_session lists what the heads-up could not fit', async () => {
    const e = await boot(versions())
    await post(e, 'toolu_v2')
    const r = String((await e.callTool('inspect_session', {}, 'toolu_i1')).result)
    assert.match(r, /Redundant older copies/)
    assert.match(r, /toolu_v1 .*superseded.*← toolu_v2.*✓ flagged automatically/)
  })
})

describe('this plugin\'s own results', () => {
  const own = (t: Transcript, id: string, tool: string, result: string) => {
    t.toolUse('m_' + id, id, tool, tool === TRIM_TOOL ? { tool_targets: [{ id: 'toolu_work' }] } : {})
    t.toolResult(id, result)
  }
  const session = () => {
    const t = new Transcript(SESSION)
    t.user('inspect and trim')
    own(t, 'toolu_i1', INSPECT_TOOL, 'x'.repeat(30_000))
    own(t, 'toolu_t1', TRIM_TOOL, 'Flagged. 1 item(s) pending: f1 stub toolu_work.')
    t.toolUse('mw', 'toolu_work', 'Read', { file_path: 'src/work.ts' })
    t.toolResult('toolu_work', blob(60_000))
    own(t, 'toolu_i2', INSPECT_TOOL, 'y'.repeat(30_000))
    return t
  }

  test('every older inspect/trim result is flagged for deletion even with autoFlag off; the newest is kept', async () => {
    const e = await boot(session(), { autoFlag: false })
    await post(e, 'toolu_i2', { tool_name: INSPECT_TOOL, tool_response: 'y'.repeat(30_000) })
    const list = await listing(e)
    assert.match(list, /auto: delete this plugin's own result toolu_i1/)
    assert.match(list, /auto: delete this plugin's own result toolu_t1/)
    assert.doesNotMatch(list, /toolu_i2/, 'the latest output is still readable')

    await e.settle(10 * MIN)
    assert.deepEqual(e.commandRuns, [`resume ${SESSION}`])
    assert.equal(callText(e, 'toolu_i1'), undefined)
    assert.equal(callText(e, 'toolu_t1'), undefined)
    assert.equal(callText(e, 'toolu_i2'), 'y'.repeat(30_000), 'only the last own result survives')
    assert.match((await e.classic('UserPromptSubmit')).additionalContext[0], /2 results from this plugin's own tools/)
  })
})

describe('the plugin cleans up after itself', () => {
  const OLD = { tool_targets: [{ id: 'toolu_old' }] }
  const session = () => {
    const t = new Transcript(SESSION)
    t.user('refactor the parser')
    t.toolUse('m0', 'toolu_old', 'Read', { file_path: 'src/old.ts' })
    t.toolResult('toolu_old', blob(90_000))
    for (let i = 0; i < 12; i++) {
      t.toolUse(`mf${i}`, `toolu_f${i}`, 'Bash', { command: 'echo' })
      t.toolResult(`toolu_f${i}`, blob(2_000))
    }
    return t
  }
  /** What the engine writes after a flagging call: the call and its "Flagged" result. */
  const flush = (e: FakeEngine, id: string, args: Record<string, unknown>, result: string) => {
    const rows = e.rows()
    const t = new Transcript(SESSION)
    ;(t as any).last = [...rows].reverse().find((r) => typeof r['uuid'] === 'string')?.['uuid'] ?? null
    ;(t as any).n = 7000 + rows.length
    e.append(t.toolUse('m_' + id, id, TRIM_TOOL, args).toolResult(id, result))
  }

  test('the newest flagging call keeps only its note when its flag is applied while idle', async () => {
    const e = await boot(session())
    const args = { regex_rules: [{ pattern: '(?:abcdefghi\\n)+', mode: 'summary', replacement: 'REPLACEMENT-TEXT-THAT-MUST-NOT-LINGER', scope_tool_ids: ['toolu_old'] }] }
    const r = await e.callTool('trim_session', args, 'toolu_flag1')
    assert.match(String(r.result), /^Flagged\./, JSON.stringify(r))
    flush(e, 'toolu_flag1', args, String(r.result))
    assert.ok(mentions(e, 'REPLACEMENT-TEXT-THAT-MUST-NOT-LINGER'), 'sanity: it is in the transcript now')

    await e.settle(10 * MIN)
    assert.deepEqual(e.commandRuns, [`resume ${SESSION}`])
    assert.match(callText(e, 'toolu_old')!, /^\[Trimmed — Summary: REPLACEMENT-TEXT-THAT-MUST-NOT-LINGER\]$/, 'the summary itself is the one place the text belongs')
    assert.equal(callText(e, 'toolu_flag1'), 'Agent pruned context: success', 'the last use keeps its short output, not the long input or "Flagged" result')
    const use = rowsToMessages(e.memory).flatMap((m) => m.toolUses).find((u) => u.tool_use_id === 'toolu_flag1')
    assert.deepEqual(use?.input, {}, 'and an empty input')
    assert.equal(JSON.stringify(e.rows()).split('REPLACEMENT-TEXT-THAT-MUST-NOT-LINGER').length - 1, 1, 'exactly one copy of the replacement text is left: the summary')
  })

  test('a queued trim clears the earlier flagging call too, and keeps only an empty shell of its own call', async () => {
    const e = await boot(session())
    const first = await e.callTool('trim_session', OLD, 'toolu_flag1')
    assert.match(String(first.result), /^Flagged\./)
    flush(e, 'toolu_flag1', OLD, String(first.result))

    const args = { ...OLD, force: true }
    const second = await e.callTool('trim_session', args, 'toolu_trim2')
    assert.match(String(second.result), /^Session trim queued/)
    await e.endTrimTurn('toolu_trim2', args)
    await e.settle(30_000)

    assert.deepEqual(e.commandRuns, [`resume ${SESSION}`])
    assert.match(callText(e, 'toolu_old')!, /^\[Trimmed/)
    assert.ok(!mentions(e, 'toolu_flag1'), 'the earlier flagging call is cleared')
    assert.equal(callText(e, 'toolu_trim2'), 'Agent pruned context: success', 'this call keeps only the short success note')
    const use = rowsToMessages(e.memory).flatMap((m) => m.toolUses).find((u) => u.tool_use_id === 'toolu_trim2')
    assert.deepEqual(use?.input, {}, 'and an empty input')
  })
})

describe('what a model reads when there is nothing to trim', () => {
  test('inspect_session says so plainly, lists no tiny text block as a candidate, and gives no stub reminder', async () => {
    const t = new Transcript(SESSION)
    t.user('Read the first line of a file and tidy up your context with trim_session when done.')
    t.toolUse('m1', 'toolu_s1', 'Read', { file_path: 'a.ts' })
    t.toolResult('toolu_s1', '1\tconst a = 1')
    const e = await boot(t)
    const r = String((await e.callTool('inspect_session', {}, 'toolu_i1')).result)
    assert.match(r, /Nothing here is worth trimming: no tool result is large enough \(the biggest is ≈\d+ tok/)
    assert.match(r, /No action needed: carry on with your task\./)
    assert.doesNotMatch(r, /Large text blocks/)
    assert.doesNotMatch(r, /Reminder: stubbed results are gone/)
  })
})

describe('a model that cannot copy a long id', () => {
  test('the refusal names the closest valid id and the biggest results, so one retry is enough', async () => {
    const e = await boot(versions())
    for (const wrong of ['tuo_v1', 'toolu_v', 'tooluv1', 'toolu_vl']) {
      const r = await e.callTool('trim_session', { tool_targets: [{ id: wrong }] }, 'toolu_bad')
      const msg = String(r.deny)
      assert.match(msg, new RegExp(`tool_use_id ${wrong} was not found`))
      assert.match(msg, /Closest valid id: toolu_v[12] \(Read\(src\/p\.ts\), ≈\d/, wrong)
      assert.match(msg, /Largest results: toolu_v[12] /)
      assert.match(msg, /Copy the id exactly/)
    }
  })

  test('an id that resembles nothing still gets the list of what exists', async () => {
    const e = await boot(versions())
    const msg = String((await e.callTool('trim_session', { tool_targets: [{ id: 'zzzzzzzzzz' }] }, 'toolu_bad')).deny)
    assert.doesNotMatch(msg, /Closest valid id/)
    assert.match(msg, /Largest results: toolu_v/)
  })
})
