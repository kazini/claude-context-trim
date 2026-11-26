import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { addFlags, autoFlagsFromFindings, describeFlag, dropInvalidAuto, ownToolFlags, requestFromFlags, settledCalls } from '../../selective-context-trim/hooks/lib/flags.ts'
import type { Flag } from '../../selective-context-trim/hooks/lib/flags.ts'
import { findRedundancy } from '../../selective-context-trim/hooks/lib/redundancy.ts'
import type { DocInput, Finding } from '../../selective-context-trim/hooks/lib/redundancy.ts'
import { applyTrimToTranscript } from '../../selective-context-trim/hooks/lib/transcript.ts'
import { chainProblems, numberedLines, pairing, parse, TRIM_TOOL, Transcript } from './fixtures.ts'

const NOTE = 'Agent pruned context: success'
const counter = () => ({ n: 0 })

function finding(over: Partial<Finding> = {}): Finding {
  return { kind: 'superseded', confidence: 'auto', oldId: 'toolu_old', newId: 'toolu_new', oldKind: 'tool', oldLabel: 'Read(a.ts)', newLabel: 'Read(a.ts)', sameSource: true, coverage: 0.9, savedChars: 9000, ...over }
}
const sectionFinding = (text = 'line one\nline two'): Finding =>
  finding({ kind: 'section', spans: [{ startLine: 4, endLine: 5, text, lines: 2, chars: text.length }] })

describe('automatic flags', () => {
  test('a whole older result becomes a summary target that points at the newer one', () => {
    const [f] = autoFlagsFromFindings([finding()], [], new Set(), counter())
    assert.equal(f?.target?.id, 'toolu_old')
    assert.equal(f?.target?.mode, 'summary')
    assert.match(f?.target?.replacement ?? '', /^superseded by newer Read\(a\.ts\) \(toolu_new\)/)
    assert.equal(f?.auto?.newId, 'toolu_new')
    assert.equal(f?.callId, undefined)
    assert.match(describeFlag(f as Flag), /auto: toolu_old superseded by newer toolu_new \(90% shared\)/)
  })

  test('an exact duplicate says so', () => {
    const [f] = autoFlagsFromFindings([finding({ kind: 'duplicate', coverage: 1 })], [], new Set(), counter())
    assert.match(f?.target?.replacement ?? '', /^identical to newer/)
  })

  test('a matching section becomes a literal rule pinned to the old result only', () => {
    const text = 'a.b*c (d)\n[e]{f}'
    const [f] = autoFlagsFromFindings([sectionFinding(text)], [], new Set(), counter())
    assert.equal(f?.rule?.scopeToolIds?.[0], 'toolu_old')
    assert.equal(f?.rule?.scopeToolIds?.length, 1)
    assert.ok(new RegExp(f?.rule?.pattern ?? '').test(text))
    assert.match(f?.rule?.replacement ?? '', /2 duplicate lines kept in newer Read\(a\.ts\) \(toolu_new\)/)
    assert.match(describeFlag(f as Flag), /auto: 2 duplicate lines of toolu_old/)
  })

  test('only confident findings about tool results are flagged; vetoed and already-flagged ones are skipped; it is idempotent', () => {
    const c = counter()
    const mixed = [finding({ confidence: 'review' }), finding({ oldKind: 'text', oldId: 'text#4' }), finding({ oldId: 'toolu_vetoed' }), finding({ oldId: 'toolu_have' }), finding({ oldId: 'toolu_ok' })]
    const have: Flag[] = [{ id: 'f9', target: { id: 'toolu_have', mode: 'stub' } }]
    const made = autoFlagsFromFindings(mixed, have, new Set(['toolu_vetoed']), c)
    assert.deepEqual(made.map((f) => f.auto?.oldId), ['toolu_ok'])
    assert.deepEqual(autoFlagsFromFindings(mixed, [...have, ...made], new Set(['toolu_vetoed']), c), [])
  })

  test('an automatic flag is dropped once the newer copy is gone or is itself being trimmed', () => {
    const [auto] = autoFlagsFromFindings([finding()], [], new Set(), counter()) as [Flag]
    assert.deepEqual(dropInvalidAuto([auto], () => true), [auto])
    assert.deepEqual(dropInvalidAuto([auto], (id) => id !== 'toolu_new'), [], 'winner no longer in the context')
    const agent: Flag = { id: 'f7', target: { id: 'toolu_new', mode: 'stub' } }
    assert.deepEqual(dropInvalidAuto([auto, agent], () => true), [agent], 'the agent flagged the winner')
    const viaRule: Flag = { id: 'f8', rule: { pattern: 'x', flags: 'g', scopeToolIds: ['toolu_new'], mode: 'stub' } }
    assert.deepEqual(dropInvalidAuto([auto, viaRule], () => true), [viaRule])
  })

  test('the agent can override: re-flagging replaces in place, silently, without spending a new flag id', () => {
    const [auto] = autoFlagsFromFindings([finding()], [], new Set(), counter()) as [Flag]
    const c = counter()
    const out = addFlags([auto], [{ id: 'toolu_old', mode: 'delete' }], [], c, 'toolu_call', 'new note')
    assert.equal(out.length, 1)
    assert.equal(out[0]?.id, auto.id)
    assert.equal(c.n, 0, 'no new flag was created')
    assert.equal(out[0]?.target?.mode, 'delete')
    assert.equal(out[0]?.auto, undefined)
    assert.equal(out[0]?.callId, 'toolu_call')
    assert.equal(out[0]?.note, 'new note')
  })

  test('this plugin\'s own results are deleted, never stubbed; vetoed and already-flagged ones are skipped', () => {
    const existing: Flag[] = [
      { id: 'f1', target: { id: 'toolu_have', mode: 'stub' } },
      { id: 'f2', rule: { pattern: 'x', flags: '', scopeToolIds: ['toolu_viaRule'], mode: 'stub' } },
    ]
    const made = ownToolFlags(['toolu_vetoed', 'toolu_have', 'toolu_viaRule', 'toolu_own'], existing, new Set(['toolu_vetoed']), counter())
    assert.deepEqual(made.map((f) => f.auto?.oldId), ['toolu_own'])
    assert.equal(made[0]?.target?.mode, 'delete')
    assert.equal(made[0]?.callId, undefined)
    assert.match(describeFlag(made[0] as Flag), /auto: delete this plugin's own result toolu_own/)
  })
})

describe('settled trim_session calls', () => {
  const f = (id: string, callId?: string): Flag => ({ id, target: { id: `t_${id}`, mode: 'stub' }, ...(callId ? { callId } : {}) })

  test('a call is settled once none of its flags remains pending', () => {
    const open = new Set(['c1', 'c2', 'c3'])
    assert.deepEqual(settledCalls(open, [f('f1', 'c1'), f('f2', 'c1')]).sort(), ['c2', 'c3'])
    assert.deepEqual(settledCalls(open, []).sort(), ['c1', 'c2', 'c3'])
    assert.deepEqual(settledCalls(open, [f('f1', 'c1'), f('f2', 'c2'), f('f3', 'c3')]), [])
    assert.deepEqual(settledCalls(new Set(), [f('f1')]), [])
  })

  test('automatic flags never keep a call open', () => {
    const [auto] = autoFlagsFromFindings([finding()], [], new Set(), counter()) as [Flag]
    assert.deepEqual(settledCalls(new Set(['c1']), [auto]), ['c1'])
  })
})

/** Two reads, a flagging call (large regex + replacement text) and more work after it. */
function withFlaggingCall(): Transcript {
  const t = new Transcript()
  t.user('start')
  t.toolUse('m1', 'toolu_a', 'Read', { file_path: 'a.ts' })
  t.toolResult('toolu_a', numberedLines(120, 'alpha'))
  t.toolUse('m2', 'toolu_b', 'Read', { file_path: 'b.ts' })
  t.toolResult('toolu_b', numberedLines(120, 'beta'))
  t.toolUse('m3', 'toolu_flag', TRIM_TOOL, { regex_rules: [{ pattern: 'alpha line \\d+', scope_tool_ids: ['toolu_a'], mode: 'summary', replacement: 'REPLACEMENT-TEXT-THAT-MUST-NOT-LINGER' }] })
  t.toolResult('toolu_flag', 'Flagged. 1 item(s) pending: f1 regex /alpha line \\d+/ summary on toolu_a.')
  t.text('m4', 'carrying on')
  t.toolUse('m5', 'toolu_c', 'Read', { file_path: 'c.ts' })
  t.toolResult('toolu_c', numberedLines(120, 'gamma'))
  return t
}
const stubA = { targets: [{ id: 'toolu_a', mode: 'stub' as const }], rules: [], note: NOTE }
const text = (lines: string[]) => lines.join('\n')

describe('clearing earlier flagging calls from the transcript', () => {
  test('a settled call disappears entirely: no regex, no replacement text, no "Flagged" result, no orphan', () => {
    const t = withFlaggingCall()
    assert.ok(text(t.lines()).includes('REPLACEMENT-TEXT-THAT-MUST-NOT-LINGER'), 'sanity: the text is there to begin with')
    const res = applyTrimToTranscript(t.lines(), stubA, { trimCallIds: [], settledCallIds: ['toolu_flag'] })
    assert.ok(res.ok)
    const out = text(res.lines)
    assert.ok(!out.includes('REPLACEMENT-TEXT-THAT-MUST-NOT-LINGER'))
    assert.ok(!out.includes('Flagged. 1 item(s) pending'))
    assert.ok(!pairing(res.lines).uses.has('toolu_flag') && !pairing(res.lines).results.has('toolu_flag'))
    assert.deepEqual([...pairing(res.lines).uses].sort(), [...pairing(res.lines).results].sort())
    assert.deepEqual(chainProblems(res.lines), [])
    assert.deepEqual(res.report.settledCleared, ['toolu_flag'])
    // and it is counted as saved
    const without = applyTrimToTranscript(t.lines(), stubA, { trimCallIds: [] })
    assert.ok(without.ok && res.report.savedChars > without.report.savedChars)
  })

  test('the rewrite point does not move: clearing a call costs no extra cache', () => {
    const t = withFlaggingCall()
    const a = applyTrimToTranscript(t.lines(), stubA, { trimCallIds: [] })
    const b = applyTrimToTranscript(t.lines(), stubA, { trimCallIds: [], settledCallIds: ['toolu_flag'] })
    assert.ok(a.ok && b.ok)
    assert.equal(b.changedFrom, a.changedFrom)
  })

  test('a settled call that sits BEFORE the first change is left alone (it would move the rewrite point back)', () => {
    const t = withFlaggingCall()
    const stubC = { targets: [{ id: 'toolu_c', mode: 'stub' as const }], rules: [], note: NOTE } // later than the flagging call
    const res = applyTrimToTranscript(t.lines(), stubC, { trimCallIds: [], settledCallIds: ['toolu_flag'] })
    assert.ok(res.ok)
    assert.deepEqual(res.report.settledCleared, [])
    assert.ok(pairing(res.lines).uses.has('toolu_flag'))
  })

  test('a call that is no longer in the transcript is reported as gone; no ids means no change; the current call still collapses', () => {
    const t = withFlaggingCall()
    const gone = applyTrimToTranscript(t.lines(), stubA, { trimCallIds: [], settledCallIds: ['toolu_not_here'] })
    assert.ok(gone.ok && gone.report.settledCleared.includes('toolu_not_here'))
    const none = applyTrimToTranscript(t.lines(), stubA, { trimCallIds: [] })
    assert.ok(none.ok && pairing(none.lines).uses.has('toolu_flag') && none.report.settledCleared.length === 0)

    const cur = withFlaggingCall()
    cur.toolUse('m6', 'toolu_trim', TRIM_TOOL, { tool_targets: [{ id: 'toolu_a' }] }).toolResult('toolu_trim', 'Session trim queued.')
    const both = applyTrimToTranscript(cur.lines(), stubA, { trimCallIds: ['toolu_trim'], settledCallIds: ['toolu_flag'] })
    assert.ok(both.ok)
    assert.equal(both.report.collapsedTrimCalls, 1)
    assert.deepEqual(both.report.settledCleared, ['toolu_flag'])
    const blocks = (l: string): Record<string, unknown>[] => {
      const c = (parse(l)['message'] as { content?: unknown } | undefined)?.content
      return Array.isArray(c) ? (c as Record<string, unknown>[]) : []
    }
    const trimUse = both.lines.flatMap((l) => blocks(l).filter((b) => b['id'] === 'toolu_trim'))
    assert.deepEqual(trimUse[0]?.['input'], {}, 'the current call keeps only an empty input')
  })
})

describe('an automatic section flag, applied for real', () => {
  const lines = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `export function ${tag}Handler${i}(input: Payload${i}): Result${i} { return transform(input, ${(i * 7919) % 1013}) }`)
  const shared = Array.from({ length: 10 }, (_, k) => [`## Shared part ${k}`, ...lines(`sh${k}`, 8)].join('\n')).join('\n')
  const unique = Array.from({ length: 10 }, (_, k) => [`## Only here ${k}`, ...lines(`un${k}`, 8)].join('\n')).join('\n')

  test('only the repeated section of the OLD result is replaced; the newer copy and the unique part are untouched', () => {
    const t = new Transcript()
    t.user('go')
    t.toolUse('m1', 'toolu_old', 'Read', { file_path: 'notes.md' })
    t.toolResult('toolu_old', `${shared}\n${unique}`)
    t.toolUse('m2', 'toolu_new', 'Bash', { command: 'cat shared.md' })
    t.toolResult('toolu_new', shared)
    const docs: DocInput[] = [
      { id: 'toolu_old', kind: 'tool', order: 1000, label: 'Read(notes.md)', text: `${shared}\n${unique}`, autoSafe: true },
      { id: 'toolu_new', kind: 'tool', order: 2000, label: 'Bash(cat shared.md)', text: shared, autoSafe: true },
    ]
    const flags = autoFlagsFromFindings(findRedundancy(docs), [], new Set(), counter())
    assert.ok(flags.length >= 1 && flags.every((f) => f.rule && f.auto?.kind === 'section'))
    const res = applyTrimToTranscript(t.lines(), requestFromFlags(flags, NOTE), { trimCallIds: [] })
    assert.ok(res.ok, res.ok ? '' : res.error)
    const body = (id: string) => {
      for (const l of res.lines) {
        const c = (parse(l)['message'] as { content?: unknown } | undefined)?.content
        if (Array.isArray(c)) for (const b of c as Record<string, unknown>[]) if (b['tool_use_id'] === id) return String(b['content'])
      }
      return ''
    }
    assert.match(body('toolu_old'), /\[Trimmed — Summary: \d+ duplicate lines/)
    assert.ok(body('toolu_old').includes('Only here 9'), 'the unique part survives')
    assert.ok(!body('toolu_old').includes('Shared part 3'), 'the repeated part is gone')
    assert.equal(body('toolu_new'), shared, 'the newer copy is untouched')
  })
})
