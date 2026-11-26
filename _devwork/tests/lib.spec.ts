import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { adviceFor, breakEven, DEFAULT_ECON, gain, gainShort, isLive, judge, readMultFor, writeMult } from '../../selective-context-trim/hooks/lib/economics.ts'
import type { CacheState, EconConfig, Reentry } from '../../selective-context-trim/hooks/lib/economics.ts'
import { analyzeSession, candidatesOf, estimatePlan, recommend, renderInspect, reentryFor } from '../../selective-context-trim/hooks/lib/inspect.ts'
import type { Msg } from '../../selective-context-trim/hooks/lib/types.ts'
import { validateTrimParams } from '../../selective-context-trim/hooks/lib/validate.ts'

const cfg: EconConfig = { ...DEFAULT_ECON }
const warm: CacheState = { ttl: '5m', readMult: 0.1, ageMs: 5_000 }

describe('cache model', () => {
  /** Independent model: price every request one by one, with a re-entry anchor A. */
  function simulate(S: number, R: number, C: number, N: number, cache: CacheState, c: EconConfig, live: boolean): number {
    const w = writeMult(cache.ttl)
    const r = cache.readMult
    const A = C - R
    // baseline: warm cache reads everything; cold cache must rewrite everything once, then reads
    const baseline = live ? N * r * C : w * C + (N - 1) * r * C
    // trimmed: warm: read prefix to the anchor, write the shrunken rest; cold: write everything shrunken
    const first = live ? r * A + w * (R - S) : w * (C - S)
    const trimmed = first + (N - 1) * r * (C - S)
    return baseline - trimmed - c.overheadRequests * r * C
  }

  test('closed-form gain equals the request-by-request simulation (warm and cold, all multipliers)', () => {
    for (const ttl of ['5m', '1h'] as const) {
      for (const readMult of [0.1, 0.05, 0.025]) {
        for (const live of [true, false]) {
          for (const [S, R, C] of [[20_000, 30_000, 120_000], [5_000, 90_000, 150_000], [60_000, 60_000, 150_000], [800, 4_000, 50_000]] as const) {
            for (const N of [1, 2, 7, 30]) {
              const cache: CacheState = { ttl, readMult }
              const got = gain(S, R, C, N, cache, cfg, live)
              assert.ok(Math.abs(got - simulate(S, R, C, N, cache, cfg, live)) < 1e-6, `${ttl} r=${readMult} live=${live} S=${S} R=${R} C=${C} N=${N}`)
            }
          }
        }
      }
    }
  })

  test('short-term gain is the first request alone; break-even is the first non-negative request count', () => {
    assert.ok(gainShort(40_000, 40_000, warm, true) > 0) // saves as much as it recomputes
    assert.ok(gainShort(10_000, 40_000, warm, true) < 0)
    assert.equal(gainShort(10_000, 40_000, warm, false), 12_500) // cold: no recompute penalty
    for (const [S, R, C] of [[20_000, 30_000, 120_000], [10_000, 100_000, 150_000], [60_000, 60_000, 150_000]] as const) {
      const be = breakEven(S, R, C, warm, cfg, true)
      assert.ok(gain(S, R, C, be, warm, cfg) >= 0)
      if (be > 1) assert.ok(gain(S, R, C, be - 1, warm, cfg) < 0)
    }
    assert.equal(breakEven(0, 10, 100, warm, cfg), Infinity)
  })

  test('read multiplier follows the model; an override wins', () => {
    assert.equal(readMultFor('claude-sonnet-5-5'), 0.05)
    assert.equal(readMultFor('claude-opus-5-5'), 0.05)
    assert.equal(readMultFor('claude-fable-5-1'), 0.025)
    assert.equal(readMultFor('claude-haiku-4-5'), 0.1)
    assert.equal(readMultFor(undefined), 0.1)
    assert.equal(readMultFor('claude-sonnet-5-5', 0.2), 0.2)
  })

  test('cache liveness: age against the TTL with a safety margin; unknown age counts as live', () => {
    assert.equal(isLive({ ttl: '5m', readMult: 0.1, ageMs: 10_000 }), true)
    assert.equal(isLive({ ttl: '5m', readMult: 0.1, ageMs: 3.9 * 60_000 }), true)
    assert.equal(isLive({ ttl: '5m', readMult: 0.1, ageMs: 4.5 * 60_000 }), false) // inside the 60s margin
    assert.equal(isLive({ ttl: '1h', readMult: 0.1, ageMs: 30 * 60_000 }), true)
    assert.equal(isLive({ ttl: '5m', readMult: 0.1 }), true)
  })
})

describe('standards', () => {
  const j = (S: number, R: number, C: number, extra: { items?: number; expectedRequests?: number; percent?: number; cache?: CacheState } = {}) =>
    judge({ S, R, C, ...(extra.items !== undefined ? { items: extra.items } : {}), ...(extra.expectedRequests !== undefined ? { expectedRequests: extra.expectedRequests } : {}), ...(extra.percent !== undefined ? { percent: extra.percent } : {}) }, extra.cache ?? warm, cfg)

  // w=1.25 r=0.1 k=2 N=12 throughout.
  test('quick cleanup: saves at least what it forces to be recomputed, and pays back', () => {
    const v = j(40_000, 40_000, 100_000)
    assert.equal(v.zone, 'good')
    assert.equal(v.standard, 'quick')
    assert.ok(v.shortTerm > 0)
  })

  test('saving less than is recomputed is not a quick cleanup, however profitable later', () => {
    const v = j(18_000, 30_000, 60_000)
    assert.notEqual(v.standard, 'quick')
    assert.notEqual(v.zone, 'good')
  })

  test('sizeable text: the ratio is waived when the saving is big, but the long-term must still pass', () => {
    const v = j(30_000, 40_000, 100_000) // S < R, S >= 20k, long-term +4.5k
    assert.equal(v.zone, 'good')
    assert.equal(v.standard, 'sizeable')
    const bad = j(30_000, 80_000, 100_000) // sizeable, but the long-term is negative
    assert.notEqual(bad.zone, 'good')
  })

  test('deliberate batch: waived ratio, but long-term must clear a margin of the recompute cost', () => {
    const lone = j(15_000, 30_000, 50_000, { expectedRequests: 40 })
    assert.equal(lone.zone, 'marginal') // one item: not a batch, not quick, not sizeable
    const batch = j(15_000, 30_000, 50_000, { expectedRequests: 40, items: 3 })
    assert.equal(batch.zone, 'good')
    assert.equal(batch.standard, 'batch')
    // barely positive long-term does not clear the 10% margin
    const barely = j(15_000, 30_000, 50_000, { expectedRequests: 19, items: 3 })
    assert.ok(barely.longTerm > 0 && barely.longTerm < 0.1 * 1.25 * 30_000)
    assert.notEqual(barely.zone, 'good')
  })

  test('cold cache: the recompute cost is paid anyway, so only the saving counts', () => {
    const cold: CacheState = { ttl: '5m', readMult: 0.1, ageMs: 10 * 60_000 }
    const sameNumbers = (cache: CacheState) => j(10_000, 90_000, 100_000, { cache })
    assert.notEqual(sameNumbers(warm).zone, 'good')
    const v = sameNumbers(cold)
    assert.equal(v.live, false)
    assert.equal(v.zone, 'good')
    assert.equal(v.standard, 'cold-cache')
    assert.match(v.summary, /already expired/)
  })

  test('zones: tiny, marginal, costly; pressure relaxes one step', () => {
    assert.equal(j(1_000, 1_000, 100_000).zone, 'tiny')
    assert.equal(j(10_000, 20_000, 60_000).zone, 'marginal') // pays back after ~24 requests (<= 3x12)
    assert.equal(j(25_000, 80_000, 150_000).zone, 'costly') // ~38 requests (> 3x12)
    assert.equal(j(10_000, 20_000, 60_000, { percent: 90 }).zone, 'good')
    assert.equal(j(25_000, 80_000, 150_000, { percent: 90 }).zone, 'marginal')
  })

  test('the expected number of requests moves the long-term test inside a standard, but cannot waive one', () => {
    // first request pays for itself (S ~ R) but the fixed overhead is not recovered in 12 requests...
    assert.notEqual(j(10_000, 10_000, 150_000).zone, 'good')
    // ...while a longer horizon recovers it
    const longer = j(10_000, 10_000, 150_000, { expectedRequests: 60 })
    assert.equal(longer.zone, 'good')
    assert.equal(longer.standard, 'quick')
    // a long horizon does NOT excuse a small trim that recomputes far more than it saves
    assert.notEqual(j(10_000, 20_000, 60_000, { expectedRequests: 30 }).zone, 'good')
  })

  test('quick rule is the exact first-request break-even: S >= (1 - r/w) * R', () => {
    // r/w = 0.08, so S = 0.93 R passes and S = 0.9 R does not (C chosen so the long-term test is not the limiter)
    assert.equal(j(37_200, 40_000, 80_000).standard, 'quick')
    assert.notEqual(j(36_000, 40_000, 80_000).standard, 'quick')
  })

  test('cheaper cache reads make later requests worth less, so the same trim is harder to justify', () => {
    const a = j(25_000, 40_000, 100_000, { cache: { ttl: '5m', readMult: 0.1, ageMs: 1000 } })
    const b = j(25_000, 40_000, 100_000, { cache: { ttl: '5m', readMult: 0.025, ageMs: 1000 } })
    assert.ok(b.longTerm !== a.longTerm)
    assert.ok(b.breakEvenRequests > a.breakEvenRequests)
  })

  test('an unreachable re-entry (beyond the lookback) is called out in the verdict and the advice', () => {
    const reentry: Reentry = { anchorTokens: 20_000, gapTokens: 60_000, recomputeTokens: 80_000, blocksAfterAnchor: 41, reachable: false, anchorMsg: -1 }
    const v = judge({ S: 10_000, C: 100_000, reentry }, warm, cfg)
    assert.match(v.summary, /20-block lookback/)
    assert.match(adviceFor(v, cfg), /whole conversation/)
    assert.equal(v.R, 80_000)
  })
})

describe('validateTrimParams', () => {
  const ok = (p: unknown) => {
    const r = validateTrimParams(p)
    assert.ok(r.ok, r.ok ? '' : r.error)
    return r
  }
  const bad = (p: unknown, re: RegExp) => {
    const r = validateTrimParams(p)
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, re)
  }

  test('accepts a mixed request and applies defaults', () => {
    const r = ok({ tool_targets: [{ id: 'toolu_01ABCdef' }], regex_rules: [{ pattern: 'DEBUG.*' }] })
    assert.equal(r.request.targets[0]?.mode, 'stub')
    assert.equal(r.request.rules[0]?.mode, 'stub')
    assert.equal(r.request.rules[0]?.flags, 'g')
    assert.equal(r.request.note, 'Agent pruned context: success')
  })

  test('rejects empty requests, bad ids, duplicates', () => {
    bad({}, /Nothing to trim/)
    bad({ tool_targets: [{ id: 'x' }] }, /tool_use_id/)
    bad({ tool_targets: [{ id: 'toolu_01AAAA' }, { id: 'toolu_01AAAA' }] }, /duplicate/)
  })

  test('summary mode requires a replacement', () => {
    bad({ tool_targets: [{ id: 'toolu_01ABCdef', mode: 'summary' }] }, /replacement/)
    bad({ regex_rules: [{ pattern: 'a', mode: 'summary' }] }, /replacement/)
    ok({ regex_rules: [{ pattern: 'a', mode: 'summary', replacement: 'short' }] })
  })

  test('regex syntax is checked immediately; empty-matching and catastrophic patterns are refused', () => {
    bad({ regex_rules: [{ pattern: '(' }] }, /invalid regular expression/)
    bad({ regex_rules: [{ pattern: 'a*' }] }, /empty string/)
    bad({ regex_rules: [{ pattern: '(a+)+$' }] }, /nested quantifier/)
    bad({ regex_rules: [{ pattern: '(\\w+\\s?)*x' }] }, /nested quantifier/)
    bad({ regex_rules: [{ pattern: 'a', flags: 'y' }] }, /unsupported flag/)
    ok({ regex_rules: [{ pattern: '(?:ab)+c', flags: 'is' }] })
  })

  test('scope and note validation', () => {
    bad({ regex_rules: [{ pattern: 'a', scope_roles: ['system'] }] }, /scope_roles/)
    bad({ regex_rules: [{ pattern: 'a', scope_tool_ids: [] }] }, /scope_tool_ids/)
    bad({ regex_rules: [{ pattern: 'a' }], expected_remaining_requests: 0 }, /expected_remaining_requests/)
    const r = ok({ regex_rules: [{ pattern: 'a' }], session_note: '  Pruned  ', force: true })
    assert.equal(r.request.note, 'Pruned')
    assert.equal(r.force, true)
  })
})

describe('cache re-entry and recommendations', () => {
  const big = (n: number) => 'x'.repeat(n)
  /** One tool call = an assistant message (tool_use) + a user message (tool_result) = 2 blocks. */
  function build(calls: [string, string, Record<string, unknown>, number][]): Msg[] {
    const m: Msg[] = [{ role: 'user', text: 'start', toolUses: [] }]
    for (const [id, tool, input, chars] of calls) {
      const body = big(chars)
      m.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input, text: body }] })
      m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: body }] })
    }
    return m
  }
  const filler = (n: number): [string, string, Record<string, unknown>, number][] => Array.from({ length: n }, (_, i) => [`toolu_f${i}`, 'Bash', { command: 'echo' }, 2_000])
  const usage = { tokens: 95_000, window: 200_000, percent: 48 }
  const messages = () => build([['toolu_old', 'Read', { file_path: 'old.ts' }, 60_000], ...filler(20), ['toolu_recent', 'Bash', { command: 'npm test' }, 70_000], ['toolu_tiny', 'Read', { file_path: 'tiny.ts' }, 200]])

  test('re-entry anchors at the last surviving cache entry before the change, within the lookback', () => {
    const a = analyzeSession(messages(), usage, cfg, warm)
    const recent = a.blocks.find((b) => b.id === 'toolu_recent')!
    const r = reentryFor(a, recent.resultMsg!)
    assert.equal(r.reachable, true)
    assert.ok(r.blocksAfterAnchor <= 20)
    assert.equal(a.messages[r.anchorMsg]?.role, 'user') // an entry sits at the end of a user message
    assert.ok(r.anchorMsg < recent.resultMsg!)
    assert.ok(r.gapTokens < 2_000) // only the unchanged tool_use sits between anchor and edit
    assert.ok(r.recomputeTokens < 30_000)
  })

  test('an edit further back than the lookback re-processes the whole conversation', () => {
    const a = analyzeSession(messages(), usage, cfg, warm)
    const old = a.blocks.find((b) => b.id === 'toolu_old')!
    const r = reentryFor(a, old.resultMsg!)
    assert.equal(r.reachable, false)
    assert.ok(r.blocksAfterAnchor > 20)
    assert.equal(r.anchorTokens, Math.min(a.overheadTokens, cfg.fixedPrefixTokens))
    assert.ok(r.recomputeTokens > 70_000)
    // disabling the lookback model makes the anchor reachable again
    const lenient = analyzeSession(messages(), usage, { ...cfg, lookbackBlocks: 10_000 }, warm)
    assert.equal(reentryFor(lenient, old.resultMsg!).reachable, true)
  })

  test('the API\'s own last-response usage calibrates where the messages start in the prompt', () => {
    const exact = { ...usage, apiUsage: { input_tokens: 300, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 31_000 } }
    const a = analyzeSession(messages(), exact, cfg, warm)
    // the prompt of the last request was 91,300 tokens and ended at the last user message
    const lastUser = a.messages.length - 1
    const estimated = Math.ceil((a.msgEnd[lastUser] ?? 0) / cfg.charsPerToken)
    assert.equal(a.overheadTokens, 91_300 - estimated)
  })

  test('recommendation: the recent big result passes; the deep one is not recommended', () => {
    const a = analyzeSession(messages(), usage, cfg, warm)
    const rec = recommend(a, candidatesOf(a, 500))
    assert.ok(rec, 'a worthwhile set exists')
    const ids = rec!.set.map((c) => c.block.id)
    assert.ok(ids.includes('toolu_recent'))
    assert.ok(!ids.includes('toolu_old'))
    assert.ok(['quick', 'sizeable'].includes(rec!.verdict.standard))
    assert.ok(!ids.includes('toolu_tiny'))
  })

  test('an expired cache lifts the penalty: the same deep trim is then worth recommending', () => {
    const cold: CacheState = { ttl: '5m', readMult: 0.1, ageMs: 20 * 60_000 }
    const a = analyzeSession(messages(), usage, cfg, cold)
    const old = candidatesOf(a, 500).find((c) => c.block.id === 'toolu_old')!
    assert.equal(old.alone.live, false)
    assert.equal(old.alone.zone, 'good')
    assert.equal(old.alone.standard, 'cold-cache')
  })

  test('already-trimmed and this plugin\'s own calls are never candidates', () => {
    const m = messages()
    m.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'toolu_own', tool: 'mcp__selective-context-trim__inspect_session', input: {}, text: big(9_000) }] })
    m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_own', text: big(9_000) }] })
    m.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'toolu_done', tool: 'Read', input: {}, text: '[Trimmed: 9 lines / 90 chars removed from Read (toolu_done)]' }] })
    const ids = candidatesOf(analyzeSession(m, usage, cfg, warm), 1).map((c) => c.block.id)
    assert.ok(!ids.includes('toolu_own'))
    assert.ok(!ids.includes('toolu_done'))
  })

  test('render output shows cache state, ids and the recommendation, and stays compact', () => {
    const a = analyzeSession(messages(), usage, cfg, warm)
    const out = renderInspect(a, { minTokens: 500, maxRows: 5, includeText: false })
    assert.match(out, /Cache: live/)
    assert.match(out, /toolu_recent/)
    assert.match(out, /★/)
    assert.ok(out.split('\n').length < 20)
    const expired = renderInspect(analyzeSession(messages(), usage, cfg, { ttl: '5m', readMult: 0.1, ageMs: 600_000 }), { minTokens: 500, maxRows: 5, includeText: false })
    assert.match(expired, /EXPIRED/)
  })

  test('estimatePlan: unknown id errors; a deep target reports an unreachable re-entry; items are counted', () => {
    const a = analyzeSession(messages(), usage, cfg, warm)
    assert.equal(estimatePlan(a, { targets: [{ id: 'toolu_missing', mode: 'stub' }], rules: [], note: 'n' }).errors.length, 1)
    const deep = estimatePlan(a, { targets: [{ id: 'toolu_old', mode: 'stub' }], rules: [], note: 'n' })
    assert.equal(deep.reentry?.reachable, false)
    const recent = estimatePlan(a, { targets: [{ id: 'toolu_recent', mode: 'stub' }, { id: 'toolu_f19', mode: 'stub' }], rules: [], note: 'n' })
    assert.equal(recent.items, 2)
    assert.equal(recent.reentry?.reachable, true)
    assert.ok(recent.S > 15_000)
  })

  test('a deliberate cross-history batch that is large enough is accepted despite the deep reach', () => {
    const a = analyzeSession(messages(), { ...usage, percent: 40 }, cfg, warm)
    const targets = [{ id: 'toolu_old', mode: 'stub' as const }, ...Array.from({ length: 20 }, (_, i) => ({ id: `toolu_f${i}`, mode: 'stub' as const })), { id: 'toolu_recent', mode: 'stub' as const }]
    const est = estimatePlan(a, { targets, rules: [], note: 'n' })
    assert.equal(est.reentry?.reachable, false)
    const alone = judge({ S: est.S, C: a.contextTokens, reentry: est.reentry!, items: 1, expectedRequests: 30 }, warm, cfg)
    const batch = judge({ S: est.S, C: a.contextTokens, reentry: est.reentry!, items: est.items, expectedRequests: 30 }, warm, cfg)
    assert.ok(batch.longTerm === alone.longTerm)
    assert.ok(est.items >= cfg.batchMinItems)
    assert.ok(batch.standard !== 'none' ? batch.zone === 'good' : true)
  })
})

describe('recommendation vs. deliberate whole-history clean-up (found in a live run)', () => {
  /** 28 large reads in a 664k-token context: the live scenario that exposed the problem. */
  function many(): Msg[] {
    const m: Msg[] = [{ role: 'user', text: 'start', toolUses: [] }]
    for (let k = 1; k <= 28; k++) {
      const body = 'x'.repeat(77_200)
      m.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `toolu_r${k}`, tool: 'Read', input: { file_path: `f${k}.ts` }, text: body }] })
      m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `toolu_r${k}`, text: body }] })
    }
    return m
  }
  const usage = { tokens: 664_000, window: 1_000_000, percent: 66 }
  const warm5: CacheState = { ttl: '5m', readMult: 0.05, ageMs: 1000 }

  test('the starred set stays inside the cache lookback (recent quick clean-up only)', () => {
    const a = analyzeSession(many(), usage, cfg, warm5)
    const rec = recommend(a, candidatesOf(a, 500))
    assert.ok(rec, 'a recent set exists')
    for (const c of rec!.set) assert.equal(reentryFor(a, c.msg).reachable, true, c.block.id)
    assert.ok(rec!.set.length < 28)
    assert.ok(rec!.set.some((c) => c.block.id === 'toolu_r28'))
    assert.ok(!rec!.set.some((c) => c.block.id === 'toolu_r1'))
  })

  test('wiping the whole history is offered separately, labelled deliberate, with its own verdict', () => {
    const a = analyzeSession(many(), usage, cfg, warm5)
    const out = renderInspect(a, { minTokens: 500, maxRows: 5, includeText: false })
    assert.match(out, /Deliberate cross-history clean-up \(NOT recommended by default/)
    assert.match(out, /28 results/)
    assert.match(out, /sizeable|batch/)
  })

  test('every starred id is listed even when max_rows is smaller than the set', () => {
    const a = analyzeSession(many(), usage, cfg, warm5)
    const rec = recommend(a, candidatesOf(a, 500))!
    const out = renderInspect(a, { minTokens: 500, maxRows: 3, includeText: false })
    for (const c of rec.set) assert.ok(out.includes(c.block.id + ' |'), `${c.block.id} missing from the table`)
  })

  test('what inspect_session stars, trim_session accepts (the set is self-consistent)', () => {
    const a = analyzeSession(many(), usage, cfg, warm5)
    const rec = recommend(a, candidatesOf(a, 500))!
    const est = estimatePlan(a, { targets: rec.set.map((c) => ({ id: c.block.id!, mode: 'stub' as const })), rules: [], note: 'n' })
    const v = judge({ S: est.S, C: a.contextTokens, items: est.items, reentry: est.reentry!, percent: 66 }, warm5, cfg)
    assert.equal(v.zone, 'good')
  })
})

describe('forward allowance for blocks that exist by the next request', () => {
  const body = 'x'.repeat(40_000)
  function msgs(n: number): Msg[] {
    const m: Msg[] = [{ role: 'user', text: 'start', toolUses: [] }]
    for (let k = 1; k <= n; k++) {
      m.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `toolu_${k}`, tool: 'Read', input: {}, text: body }] })
      m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `toolu_${k}`, text: body }] })
    }
    return m
  }
  const warm: CacheState = { ttl: '5m', readMult: 0.05, ageMs: 1000 }
  const usage = { tokens: 300_000, window: 1_000_000, percent: 30 }

  test('the same edit is in reach now but out of reach once the coming blocks are counted', () => {
    const m = msgs(10) // the edit in call 6 sits 10 blocks before the end
    const now = analyzeSession(m, usage, cfg, warm, 0)
    const later = analyzeSession(m, usage, cfg, warm, 12)
    const idx = now.blocks.find((b) => b.id === 'toolu_6')!.resultMsg!
    assert.equal(reentryFor(now, idx).reachable, true)
    assert.equal(reentryFor(later, idx).reachable, false)
    assert.equal(reentryFor(later, idx).blocksAfterAnchor, reentryFor(now, idx).blocksAfterAnchor + 12)
  })

  test('what inspect (allowance 8) stars is still reachable when trim looks later (allowance 4, 3 more blocks present)', () => {
    const base = msgs(14)
    const insp = analyzeSession(base, usage, cfg, warm, 8)
    const rec = recommend(insp, candidatesOf(insp, 500))!
    assert.ok(rec.set.length > 0)
    // by the time trim_session is called, the inspect call + result + the trim call are in the context
    const grown: Msg[] = [
      ...base,
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'toolu_insp', tool: 'mcp__selective-context-trim__inspect_session', input: {}, text: 'r' }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_insp', text: 'r' }] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'toolu_trim', tool: 'mcp__selective-context-trim__trim_session', input: {}, text: undefined }] },
    ]
    const trim = analyzeSession(grown, usage, cfg, warm, 4)
    const est = estimatePlan(trim, { targets: rec.set.map((c) => ({ id: c.block.id!, mode: 'stub' as const })), rules: [], note: 'n' })
    assert.equal(est.errors.length, 0)
    assert.equal(est.reentry?.reachable, true)
  })
})

describe('regex safety heuristic (refined after a live session)', () => {
  const verdict = (pattern: string, flags?: string) => validateTrimParams({ regex_rules: [{ pattern, mode: 'delete', ...(flags ? { flags } : {}) }] }).ok

  test('repeated line groups that must end in a newline are accepted', () => {
    for (const p of ['(?:DEBUG[^\\n]*\\n)+', '(?:  at [^\\n]+\\n)+', '(?:\\d+\\tf5 L\\d+ [^\\n]*\\n)+', '(?:ERROR .*\\n)+', '(?:[a-z]+: [^\\n]*\\n){2,}', '(?:foo|bar)+', '(?:ERR|WARN)[^\\n]*\\n']) {
      assert.equal(verdict(p), true, p)
    }
  })

  test('genuinely ambiguous nested quantifiers are still refused', () => {
    for (const p of ['(lorem+ )+ipsum', '(a+)+$', '(\\w+\\s?)*x', '(?:\\s+x)+', '(?:foo[^\\n]*\\n?)+', '(.*)*', '(?:a|aa)+b', '(?:ab|a)+c', '(?:\\d|\\w)+x', '(?:[^\\n]*)+']) {
      assert.equal(verdict(p), false, p)
    }
  })

  test('the s flag makes `.` cross lines, so a dotall line group is refused', () => {
    assert.equal(verdict('(?:ERROR .*\\n)+'), true)
    assert.equal(verdict('(?:ERROR .*\\n)+', 's'), false)
  })

  test('an accepted shape is linear on adversarial input (long near-miss runs)', () => {
    const re = new RegExp('(?:DEBUG[^\\n]*\\n)+', 'g')
    // 200k lines that almost match, then runs that match: no backtracking blow-up either way
    const near = 'DEBUG x'.repeat(5) + '\n'
    const text = 'DEBUG ok\n'.repeat(100_000) + near.repeat(100_000) + 'tail'
    const t0 = Date.now()
    const n = (text.match(re) ?? []).length
    const ms = Date.now() - t0
    assert.ok(n >= 1)
    assert.ok(ms < 1000, `took ${ms} ms`)
  })
})

describe('toolLabel', () => {
  test('a long file path keeps its end, a long command keeps its start', async () => {
    const { toolLabel } = await import('../../selective-context-trim/hooks/lib/format.ts')
    const p = toolLabel('Read', { file_path: '/home/someone/projects/a-rather-long-project-name/src/deeply/nested/module/file.ts' })
    assert.ok(p.startsWith('Read(…') && p.endsWith('nested/module/file.ts)') && p.length <= 56, p)
    const c = toolLabel('Bash', { command: 'npm run build -- --verbose --target=production --out-dir=/tmp/build-output-directory' })
    assert.ok(c.startsWith('Bash(npm run build -- --verbose'), c)
    assert.equal(toolLabel('Read', { file_path: 'src/a.ts' }), 'Read(src/a.ts)')
  })
})
