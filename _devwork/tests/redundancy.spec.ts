import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { join } from 'node:path'

import { DEFAULT_REDUNDANCY, escapeRegExp, findRedundancy, normLine, redundancyConfig, segmentLines } from '../../selective-context-trim/hooks/lib/redundancy.ts'
import type { DocInput, Finding } from '../../selective-context-trim/hooks/lib/redundancy.ts'

const repo = (p: string) => readFileSync(join(import.meta.dirname, '..', '..', p), 'utf8')
/** `Read` output: every line prefixed with its number and a tab. */
const numbered = (text: string, from = 1) => text.split('\n').map((l, i) => `${i + from}\t${l}`).join('\n')

let order = 0
const reset = () => {
  order = 0
}
function doc(label: string, text: string, opts: Partial<DocInput> = {}): DocInput {
  order += 1
  return { id: `toolu_${order}`, kind: 'tool', order: order * 1000, label, text, autoSafe: true, ...opts }
}
const read = (path: string, text: string, tool = 'Read') => doc(`${tool}(${path})`, text, { sourceKey: `${tool}\u0000${path}` })
const scan = (docs: DocInput[], cfg = DEFAULT_REDUNDANCY): Finding[] => findRedundancy(docs, cfg)

/** Distinct, realistic-looking lines (no two alike across tags). */
const distinct = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `export function ${tag}Handler${i}(input: Payload${i}): Result${i} { return transform(input, ${(i * 7919) % 1013}) }`).join('\n')
const edit = (text: string, every: number, at = 3) => text.split('\n').map((l, i) => (i % every === at ? `${l} // edited` : l)).join('\n')

describe('what counts as the same line', () => {
  test('Read line numbers (tab or arrow) and spacing do not matter', () => {
    assert.equal(normLine('   42\tconst  x = 1'), 'const x = 1')
    assert.equal(normLine('  42→const x = 1  '), 'const x = 1')
    assert.equal(normLine('12: not a read prefix'), '12: not a read prefix')
  })

  test('the escaped text of a span matches exactly itself, whatever it contains', () => {
    const t = 'a.b*c?d(e)[f]{g}|h^i$j\\k\n  /re+/gi "q" \'s\''
    assert.ok(new RegExp(escapeRegExp(t)).test(`before\n${t}\nafter`))
    assert.equal(`x${t}y`.replace(new RegExp(escapeRegExp(t), 'g'), '#'), 'x#y')
  })
})

describe('whole results: the newer copy wins', () => {
  test('a file re-read after edits supersedes the old read (same source, tolerance for changes)', () => {
    reset()
    const reg = repo('selective-context-trim/hooks/register.ts')
    const f = scan([read('register.ts', numbered(reg)), read('register.ts', numbered(edit(reg, 7)))])
    assert.equal(f.length, 1)
    assert.equal(f[0]?.oldId, 'toolu_1')
    assert.equal(f[0]?.newId, 'toolu_2')
    assert.equal(f[0]?.kind, 'superseded')
    assert.equal(f[0]?.confidence, 'auto')
    assert.equal(f[0]?.sameSource, true)
  })

  test('the NEWEST copy is never the one flagged, however the copies are ordered in the input', () => {
    reset()
    const reg = repo('selective-context-trim/hooks/register.ts')
    const docs = [read('register.ts', numbered(reg)), read('register.ts', numbered(edit(reg, 9, 1))), read('register.ts', numbered(edit(reg, 11, 5)))]
    const f = scan(docs)
    assert.deepEqual(f.map((x) => x.oldId).sort(), ['toolu_1', 'toolu_2'])
    assert.ok(f.every((x) => x.newId === 'toolu_3'))
    assert.deepEqual(scan([...docs].reverse()), f, 'input order does not matter')
  })

  test('a ranged read followed by the full read is an exact duplicate; sections moved around still match', () => {
    reset()
    const reg = repo('selective-context-trim/hooks/register.ts')
    const lines = reg.split('\n')
    const a = scan([read('register.ts', numbered(lines.slice(0, 400).join('\n'))), read('register.ts', numbered(reg))])
    assert.equal(a[0]?.kind, 'duplicate')
    reset()
    const readme = repo('README.md')
    const sections = readme.split(/\n(?=## )/)
    const b = scan([read('README.md', readme), read('README.md', [sections[0], ...sections.slice(1).reverse()].join('\n'))])
    assert.equal(b[0]?.kind, 'duplicate', 'reordered sections are the same content')
  })

  test('a re-run command whose output differs slightly supersedes the old output', () => {
    reset()
    const run = Array.from({ length: 160 }, (_, i) => `✔ suite ${Math.floor(i / 8)} case ${i} behaves as expected (${(i % 9) + 0.5}ms)`).join('\n')
    const run2 = run.replace('case 17 behaves', 'case 17 FAILED').replace('case 90 behaves', 'case 90 FAILED')
    const f = scan([read('npm test', run, 'Bash'), read('npm test', run2, 'Bash')])
    assert.equal(f[0]?.kind, 'superseded')
    assert.equal(f[0]?.confidence, 'auto')
  })

  test('a heavy rewrite (half the lines changed) is only worth a mention, never an automatic flag', () => {
    reset()
    const reg = repo('selective-context-trim/hooks/register.ts')
    const f = scan([read('register.ts', numbered(reg)), read('register.ts', numbered(edit(reg, 2, 0)))])
    assert.equal(f[0]?.confidence, 'review')
  })
})

describe('what must NOT be flagged', () => {
  test('different source files are not copies of each other, however alike their structure', () => {
    reset()
    const files = ['flags.ts', 'format.ts', 'inspect.ts', 'regex.ts', 'transcript.ts', 'types.ts', 'validate.ts', 'economics.ts'].map((f) => read(`lib/${f}`, numbered(repo(`selective-context-trim/hooks/lib/${f}`))))
    assert.deepEqual(scan(files), [])
    reset()
    const specs = ['lib', 'transcript', 'flow'].map((f) => read(`${f}.spec.ts`, numbered(readFileSync(join(import.meta.dirname, `${f}.spec.ts`), 'utf8'))))
    assert.deepEqual(scan(specs), [])
  })

  test('two different documents are left alone', () => {
    reset()
    assert.deepEqual(scan([read('README.md', repo('README.md')), read('package_plugin.py', repo('_devwork/package_plugin.py'))]), [])
  })

  test('a near copy from a DIFFERENT source (90% alike) is not flagged: sibling files share a lot without being copies', () => {
    reset()
    const a = distinct(300, 'a')
    const b = a.split('\n').map((l, i) => (i % 10 === 0 ? `${l} // changed` : l)).join('\n')
    const f = scan([read('src/a.ts', a), read('src/b.ts', b)])
    assert.ok(f.every((x) => x.confidence !== 'auto'), JSON.stringify(f))
  })

  test('a line that shows up in many results is boilerplate and proves nothing', () => {
    reset()
    const boiler = Array.from({ length: 60 }, (_, i) => `// licence boilerplate line number ${i} of the shared header`).join('\n')
    const docs = Array.from({ length: 8 }, (_, i) => read(`src/f${i}.ts`, `${boiler}\n${distinct(120, `f${i}x`)}`))
    assert.deepEqual(scan(docs), [])
  })

  test('small results are never considered', () => {
    reset()
    const small = distinct(20, 's')
    assert.deepEqual(scan([read('a', small), read('a', small)]), [])
  })

  test('message text is reported for review but can never be flagged automatically', () => {
    reset()
    const body = distinct(200, 'p')
    const f = scan([doc('user text #3', body, { kind: 'text', autoSafe: false, role: 'user' }), doc('assistant text #9', body, { kind: 'text', autoSafe: false, role: 'assistant' })])
    assert.equal(f.length, 1)
    assert.equal(f[0]?.confidence, 'review')
    assert.equal(f[0]?.oldKind, 'text')
  })
})

describe('sections of a result', () => {
  test('the part of a full read that a later ranged read repeats is found, tightly, and is exact old text', () => {
    reset()
    const reg = repo('selective-context-trim/hooks/register.ts')
    const lines = reg.split('\n')
    const oldText = numbered(reg)
    const f = scan([read('register.ts', oldText), read('register.ts', numbered(lines.slice(299, 700).join('\n'), 300))])
    assert.equal(f.length, 1)
    assert.equal(f[0]?.kind, 'section')
    const span = f[0]?.spans?.[0]
    assert.ok(span)
    // 0-based lines: the slice is 299..699. A little slack on either side, never a big overshoot.
    assert.ok(span.startLine >= 299 - 20 && span.startLine <= 299 + 20, `starts at ${span.startLine}`)
    assert.ok(span.endLine >= 699 - 20 && span.endLine <= 699 + 20, `ends at ${span.endLine}`)
    assert.equal(span.text, oldText.split('\n').slice(span.startLine, span.endLine + 1).join('\n'), 'the span is a verbatim slice of the old body')
    assert.equal(oldText.split(span.text).length - 1, 1, 'and it occurs once, so a literal rule hits exactly that')
  })

  test('sections are cut at headers when the text has them', () => {
    const lines = ['# A', 'x'.repeat(400), 'y'.repeat(400), '## B', 'z'.repeat(400), 'w'.repeat(400), '## C', 'q'.repeat(400), 'r'.repeat(400)]
    const segs = segmentLines(lines)
    assert.deepEqual(segs.map((s) => [s.start, s.end]), [[0, 2], [3, 5], [6, 8]])
    assert.deepEqual(segs.map((s) => s.header), ['# A', '## B', '## C'])
  })

  test('a document that is partly repeated yields a section flag, never a whole-body one', () => {
    reset()
    const shared = Array.from({ length: 12 }, (_, k) => `## Shared part ${k}\n${distinct(8, `sh${k}`)}`).join('\n')
    const unique = Array.from({ length: 12 }, (_, k) => `## Only here ${k}\n${distinct(8, `un${k}`)}`).join('\n')
    const f = scan([doc('Read(notes.md)', `${shared}\n${unique}`), doc('Bash(cat shared.md)', shared)])
    assert.equal(f.length, 1)
    assert.equal(f[0]?.kind, 'section')
    assert.ok((f[0]?.spans?.length ?? 0) >= 1)
    for (const s of f[0]?.spans ?? []) assert.ok(!s.text.includes('Only here'), 'unique content is never inside a span')
    assert.ok((f[0]?.savedChars ?? 0) < `${shared}\n${unique}`.length * 0.7)
  })
})

describe('behaviour of the scan itself', () => {
  test('deterministic, and bounded on a large history', () => {
    reset()
    const big = Array.from({ length: 40 }, (_, i) => read(`f${i}.ts`, numbered(distinct(900, `big${i % 5}x`))))
    const t0 = Date.now()
    const a = scan(big)
    assert.ok(Date.now() - t0 < 4000, 'a 40-result history is scanned well within a few seconds')
    assert.deepEqual(scan(big), a)
  })

  test('the similarity option raises the bar for different sources and lowers nothing below 0.5', () => {
    assert.equal(redundancyConfig(0.99, 3.5).similarity, 0.99)
    assert.equal(redundancyConfig(0.2, 3.5).similarity, 0.5)
    assert.equal(redundancyConfig(0.95, 3.5).sameSourceSimilarity, 0.6)
    assert.equal(redundancyConfig(0.95, 3.5).sameSourceSectionSimilarity, 0.85)
    assert.equal(redundancyConfig(undefined, 3.5).similarity, DEFAULT_REDUNDANCY.similarity)
  })
})

describe('pointers that name what replaced the text', () => {
  test('a long path keeps its END (the file name), not its beginning', async () => {
    const { shortLabel } = await import('../../selective-context-trim/hooks/lib/redundancy.ts')
    assert.equal(shortLabel('Read(src/a.ts)', 56), 'Read(src/a.ts)')
    const s = shortLabel('Read(/home/claude/claudecode-mod_session-trim/_devwork/cc_testenv/work/dup.txt)', 40)
    assert.ok(s.length <= 40 && s.startsWith('Read(…') && s.endsWith('work/dup.txt)'), s)
    assert.equal(shortLabel('Bash(npm run test -- --reporter=spec --coverage)', 20).startsWith('Bash(…'), true)
    assert.ok(shortLabel('just some long label with no brackets at all', 12).length <= 12)
  })
})
