import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { fmtInt } from '../../selective-context-trim/hooks/lib/format.ts'
import { applyTrimToTranscript } from '../../selective-context-trim/hooks/lib/transcript.ts'
import type { Rule, Target, TrimRequest } from '../../selective-context-trim/hooks/lib/types.ts'
import { chainProblems, numberedLines, pairing, parse, scenario, TRIM_TOOL, Transcript } from './fixtures.ts'

const NOTE = 'Agent pruned context: success'
const CTX = { trimCallIds: ['toolu_trim1'] }

function req(targets: (Partial<Target> & { id: string })[] = [], rules: Partial<Rule>[] = [], note = NOTE): TrimRequest {
  return {
    targets: targets.map((t) => ({ mode: 'stub' as const, ...t })),
    rules: rules.map((r) => ({ pattern: 'x', flags: 'g', mode: 'stub' as const, ...r })),
    note,
  }
}

function run(t: Transcript, r: TrimRequest, ctx = CTX) {
  const res = applyTrimToTranscript(t.lines(), r, ctx)
  assert.ok(res.ok, res.ok ? '' : res.error)
  return res
}

function blocksOf(line: string): Record<string, unknown>[] {
  const c = (parse(line)['message'] as { content?: unknown } | undefined)?.content
  return Array.isArray(c) ? (c as Record<string, unknown>[]) : []
}

function resultContent(lines: string[], id: string): unknown {
  for (const l of lines) {
    const c = (parse(l)['message'] as { content?: unknown[] } | undefined)?.content
    if (!Array.isArray(c)) continue
    for (const b of c as Record<string, unknown>[]) if (b['type'] === 'tool_result' && b['tool_use_id'] === id) return b['content']
  }
  return undefined
}

describe('tool_targets', () => {
  test('stub (default) writes accurate line and char counts', () => {
    const t = scenario()
    const original = numberedLines(142, 'auth')
    const res = run(t, req([{ id: 'toolu_read1', mode: 'stub' }]))
    assert.equal(
      resultContent(res.lines, 'toolu_read1'),
      `[Trimmed: 142 lines / ${fmtInt(original.length)} chars removed from Read(src/auth.ts) (toolu_read1)]`,
    )
    assert.equal(res.report.stubbed[0]?.lines, 142)
    assert.equal(res.report.stubbed[0]?.chars, original.length)
    // the tool_use is kept, so the pair stays balanced
    assert.ok(pairing(res.lines).uses.has('toolu_read1'))
    assert.ok(pairing(res.lines).results.has('toolu_read1'))
  })

  test('summary replaces the body with the agent-supplied takeaway', () => {
    const res = run(scenario(), req([{ id: 'toolu_read1', mode: 'summary', replacement: 'verifyToken ignores expiry (line 88).' }]))
    assert.equal(resultContent(res.lines, 'toolu_read1'), '[Trimmed — Summary: verifyToken ignores expiry (line 88).]')
  })

  test('delete removes the tool_use AND the tool_result: nothing is orphaned', () => {
    const t = scenario()
    const res = run(t, req([{ id: 'toolu_bash1', mode: 'delete' }]))
    const p = pairing(res.lines)
    assert.ok(!p.uses.has('toolu_bash1'))
    assert.ok(!p.results.has('toolu_bash1'))
    assert.deepEqual([...p.uses].sort(), [...p.results].sort())
    assert.deepEqual(chainProblems(res.lines), [])
    assert.equal(res.report.deleted[0]?.id, 'toolu_bash1')
  })

  test('a result given as an array of text blocks is measured and replaced as one string', () => {
    const t = new Transcript()
    t.user('go').toolUse('m1', 'toolu_a1', 'Read', { file_path: 'a.ts' })
    t.toolResult('toolu_a1', [{ type: 'text', text: 'one\ntwo' }, { type: 'text', text: 'three' }])
    t.toolUse('m2', 'toolu_trim1', TRIM_TOOL, {}).toolResult('toolu_trim1', 'queued')
    const res = run(t, req([{ id: 'toolu_a1' }]))
    assert.equal(resultContent(res.lines, 'toolu_a1'), '[Trimmed: 3 lines / 13 chars removed from Read(a.ts) (toolu_a1)]')
  })

  test('a result ending in a newline is not over-counted by one line', () => {
    const t = new Transcript()
    t.user('go').toolUse('m1', 'toolu_a1', 'Bash', { command: 'ls' }).toolResult('toolu_a1', 'a\nb\nc\n')
    t.toolUse('m2', 'toolu_trim1', TRIM_TOOL, {}).toolResult('toolu_trim1', 'queued')
    const res = run(t, req([{ id: 'toolu_a1' }]))
    assert.equal(resultContent(res.lines, 'toolu_a1'), '[Trimmed: 3 lines / 6 chars removed from Bash(ls) (toolu_a1)]')
  })

  test('already-trimmed results are left alone and reported', () => {
    const first = run(scenario(), req([{ id: 'toolu_read1' }]))
    const t2 = applyTrimToTranscript(first.lines, req([{ id: 'toolu_read1' }, { id: 'toolu_grep1' }]), CTX)
    assert.ok(t2.ok)
    if (t2.ok) {
      assert.deepEqual(t2.report.alreadyTrimmed, ['toolu_read1'])
      assert.equal(t2.report.stubbed.length, 1)
    }
  })

  test('errors: unknown id, the trim call itself, delete without its tool_use', () => {
    const t = scenario()
    const bad = applyTrimToTranscript(t.lines(), req([{ id: 'toolu_nope' }]), CTX)
    assert.equal(bad.ok, false)
    const self = applyTrimToTranscript(t.lines(), req([{ id: 'toolu_trim1' }]), CTX)
    assert.equal(self.ok, false)
    // window that starts after the tool_use: only the result is present
    const windowed = t.lines().filter((l) => !l.includes('"type":"tool_use","id":"toolu_read1"'))
    const del = applyTrimToTranscript(windowed, req([{ id: 'toolu_read1', mode: 'delete' }]), CTX)
    assert.equal(del.ok, false)
    if (!del.ok) assert.match(del.error, /orphan/)
  })
})

describe('regex_rules', () => {
  test('stub mode reports matched lines/chars; delete mode removes cleanly', () => {
    const t = scenario()
    const res = run(t, req([], [{ pattern: 'DEBUG noisy line \\d+\\n?', flags: '', mode: 'delete', scopeToolIds: ['toolu_bash1'] }]))
    const body = resultContent(res.lines, 'toolu_bash1') as string
    assert.ok(!body.includes('DEBUG'))
    assert.equal(res.report.rules[0]?.matches, 10)

    const res2 = run(scenario(), req([], [{ pattern: 'match 1\\d: [^\\n]*\\n', mode: 'stub' }]))
    const stubbed = resultContent(res2.lines, 'toolu_grep1') as string
    assert.match(stubbed, /\[Trimmed: 1 lines \/ \d+ chars matched\]/)
  })

  test('summary mode wraps the replacement', () => {
    const res = run(scenario(), req([], [{ pattern: 'Found the failing test; searching\\.', mode: 'summary', replacement: 'located failing test' }]))
    const texts = res.lines.flatMap(blocksOf)
    assert.ok(texts.some((b) => b['text'] === '[Trimmed — Summary: located failing test]'))
  })

  test('only decoded text is matched: JSON keys and ids are invisible to rules', () => {
    const res = run(scenario(), req([], [{ pattern: 'uuid|parentUuid|tool_use_id|"type"|toolu_read1', mode: 'delete' }]))
    assert.equal(res.report.rules[0]?.matches, 0)
    assert.equal(res.report.changed, false)
  })

  test('scope_roles and scope_tool_ids restrict where a rule applies', () => {
    const asst = run(scenario(), req([], [{ pattern: 'search', mode: 'delete', scopeRoles: ['assistant'] }]))
    assert.equal(asst.report.rules[0]?.matches, 1) // "searching" in the assistant text
    const userOnly = run(scenario(), req([], [{ pattern: 'search', mode: 'delete', scopeRoles: ['user'] }]))
    assert.equal(userOnly.report.rules[0]?.matches, 0)
    const scoped = run(scenario(), req([], [{ pattern: 'match \\d+', mode: 'stub', scopeToolIds: ['toolu_grep1'] }]))
    assert.equal(scoped.report.rules[0]?.blocks, 1)
    assert.ok(!String(resultContent(scoped.lines, 'toolu_read1')).includes('Trimmed'))
  })

  test('zero-length matches are ignored; a block emptied by deletion is dropped, not left empty', () => {
    const t = new Transcript()
    t.user('hi').text('m1', 'REMOVE ME').text('m2', 'keep')
    t.toolUse('m3', 'toolu_trim1', TRIM_TOOL, {}).toolResult('toolu_trim1', 'queued')
    const r = run(t, req([], [{ pattern: 'REMOVE ME', mode: 'delete' }, { pattern: 'x*', mode: 'stub' }]))
    assert.ok(!r.lines.join('\n').includes('REMOVE ME'))
    assert.equal(r.report.rules[1]?.matches, 0)
    assert.deepEqual(chainProblems(r.lines), [])
    for (const l of r.lines) {
      const c = (parse(l)['message'] as { content?: unknown } | undefined)?.content
      if (Array.isArray(c)) assert.ok(c.length > 0)
    }
  })
})

describe('mixed request, in a single call', () => {
  test('targets run first, then rules on what is left; the trim turn is collapsed', () => {
    const res = run(
      scenario(),
      req(
        [
          { id: 'toolu_read1', mode: 'stub' },
          { id: 'toolu_grep1', mode: 'summary', replacement: 'three usages found' },
          { id: 'toolu_bash1', mode: 'delete' },
        ],
        // would match inside the Read body, but that body was already stubbed away by the target pass
        [{ pattern: 'compute\\(\\d+\\)', mode: 'delete' }, { pattern: 'Found the failing test', mode: 'stub' }],
      ),
    )
    assert.equal(res.report.stubbed.length, 2)
    assert.equal(res.report.deleted.length, 1)
    assert.equal(res.report.rules[0]?.matches, 0)
    assert.equal(res.report.rules[1]?.matches, 1)
    assert.deepEqual(chainProblems(res.lines), [])
    const p = pairing(res.lines)
    assert.deepEqual([...p.uses].sort(), [...p.results].sort())
    assert.equal(resultContent(res.lines, 'toolu_trim1'), NOTE)
  })

  test('the trim_session call is collapsed to the note (custom note too)', () => {
    const res = run(scenario(), req([{ id: 'toolu_read1' }], [], 'Pruned 1 Read'))
    assert.equal(resultContent(res.lines, 'toolu_trim1'), 'Pruned 1 Read')
    const use = res.lines.flatMap(blocksOf).find((b) => b['id'] === 'toolu_trim1')
    assert.deepEqual(use?.['input'], {})
    const resultLine = res.lines.map(parse).find((o) => JSON.stringify(o['message']).includes('"tool_use_id":"toolu_trim1"'))
    // the duplicated bulk copy of the result must not keep the old text either
    assert.ok(!JSON.stringify(resultLine?.['toolUseResult']).includes('queued'))
  })
})

describe('thinking-block sanitisation and chain repair', () => {
  test('thinking blocks are stripped from the earliest modified line onward, and only there', () => {
    // m1's thinking comes BEFORE the first modified line (the Read result); the rest come after
    const res = run(scenario(), req([{ id: 'toolu_read1' }]))
    const kinds = res.lines.flatMap(blocksOf).map((b) => b['type'] as string)
    assert.equal(kinds.filter((k) => k === 'thinking').length, 1, 'only the pre-change thinking block survives')
    assert.equal(res.report.thinkingBlocksStripped, 3)
    const survivor = res.lines.map(parse).find((o) => JSON.stringify(o['message']).includes('plan: read auth first'))
    assert.ok(survivor, 'm1 thinking is untouched')
  })

  test('lines emptied by stripping/deleting are removed and the parentUuid chain stays unbroken', () => {
    const t = scenario()
    const res = run(t, req([{ id: 'toolu_bash1', mode: 'delete' }, { id: 'toolu_grep1' }]))
    assert.deepEqual(chainProblems(res.lines), [])
    assert.ok(res.report.linesRemoved >= 4) // 3 thinking lines + bash use/result
    assert.ok(res.report.parentLinksRepaired >= 1)
    // linked list is still linear: exactly one root, every uuid has at most one child
    const objs = res.lines.map(parse)
    const kids = new Map<string, number>()
    for (const o of objs) if (typeof o['parentUuid'] === 'string') kids.set(o['parentUuid'], (kids.get(o['parentUuid']) ?? 0) + 1)
    assert.ok([...kids.values()].every((n) => n === 1))
    assert.equal(objs.filter((o) => o['parentUuid'] === null).length, 1)
  })

  test('lines before the first change are byte-identical and changedFrom points at it', () => {
    const t = scenario()
    const before = t.lines()
    const res = run(t, req([{ id: 'toolu_read1' }]))
    assert.equal(res.changedFrom, 4) // user, thinking, text, tool_use are untouched; the result is line 4
    assert.deepEqual(res.lines.slice(0, res.changedFrom), before.slice(0, res.changedFrom))
  })
})

describe('robustness', () => {
  test('opaque and metadata lines pass through verbatim', () => {
    const t = scenario()
    t.meta({ type: 'file-history-snapshot', messageId: 'x', snapshot: { a: 1 } })
    const lines = t.lines()
    lines.splice(2, 0, 'this is not json {{{')
    const res = applyTrimToTranscript(lines, req([{ id: 'toolu_read1' }]), CTX)
    assert.ok(res.ok)
    if (res.ok) {
      assert.ok(res.lines.includes('this is not json {{{'))
      assert.ok(res.lines.some((l) => l.includes('file-history-snapshot')))
    }
  })

  test('nothing but the collapse to do reports changed=false', () => {
    const res = run(scenario(), req([], [{ pattern: 'zzzz-no-match', mode: 'delete' }]))
    assert.equal(res.report.changed, false)
  })

  test('does not mutate its input and is deterministic', () => {
    const t = scenario()
    const lines = t.lines()
    const copy = [...lines]
    const a = applyTrimToTranscript(lines, req([{ id: 'toolu_read1' }]), CTX)
    const b = applyTrimToTranscript(lines, req([{ id: 'toolu_read1' }]), CTX)
    assert.deepEqual(lines, copy)
    assert.deepEqual(a, b)
  })
})
