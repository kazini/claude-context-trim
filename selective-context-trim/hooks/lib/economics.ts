import { fmtInt, fmtTok } from './format.ts'

/*
 * Cost model for trimming mid-conversation, in "base input token equivalents".
 * A cache READ costs r (0.1x for most models, 0.05x on Opus/Sonnet 5.5, 0.025x on
 * Fable/Mythos 5.1), a cache WRITE costs w (1.25x for the 5-minute TTL, 2x for 1h).
 *
 * How the prompt cache really behaves (Anthropic's prompt-caching docs):
 *  - an entry is written only at a cache_control breakpoint, and covers the prefix
 *    up to it; Claude Code's breakpoint moves to the end of every request, so each
 *    earlier request left an entry at ITS end;
 *  - a request looks back from its own breakpoint over at most 20 blocks for an
 *    entry whose prefix is unchanged;
 *  - a changed block therefore kills every entry at or after it, and the next
 *    request can only re-enter at the last surviving entry BEFORE the edit, and
 *    only if that entry is within 20 blocks of the new end. Otherwise the whole
 *    conversation is processed again;
 *  - entries live 5 minutes (or 1h), refreshed free on use; the clock runs from
 *    the START of the request that wrote/read them.
 *
 * So the tokens that must be recomputed are R = C - A, where C is the context and
 * A the re-entry anchor (NOT the edit itself), and S <= R is what the trim removes.
 *
 * Without the trim every later request reads the whole context: r*C. With it, the
 * first request reads the prefix up to the anchor (r*A) and WRITES the rest,
 * shrunken (w*(R-S)); the N-1 after it read r*(C-S):
 *
 *   short-term (first request) = w*S - (w-r)*R
 *   long-term(N)               = w*S + (N-1)*r*S - (w-r)*R - k*r*C
 *
 * k is the number of extra full-context requests the mechanism itself costs
 * (inspect_session, the closing message). When the cache is already cold the
 * (w-r)*R term disappears: the whole prefix is rewritten whether or not we trim.
 */
export interface EconConfig {
  /** `auto` follows the TTL observed in the API's own usage (falls back to 5m). */
  cacheTtl: 'auto' | '5m' | '1h'
  /** Read multiplier; 0 picks it from the model. */
  cacheReadMultiplier: number
  assumedRemainingRequests: number
  overheadRequests: number
  minSavingsTokens: number
  /**
   * Quick cleanup standard: the first request after the trim must already pay for itself,
   * i.e. w*S >= quickRatio * (w-r) * R. At 1 that is "saves at least as much as it forces
   * the cache to recompute", corrected for a read being cheaper than a write.
   */
  quickRatio: number
  /** At or above this many tokens saved, the quick ratio is waived (long-term must still pass). */
  sizeableTokens: number
  /** A request with at least this many targets+rules is a deliberate cross-history batch. */
  batchMinItems: number
  /** A batch must clear the long-term gain by this share of the recompute cost. */
  batchMargin: number
  /** Context % at which freeing space is valued beyond the cost model. */
  pressurePercent: number
  /** How many blocks back the API looks for a surviving cache entry. */
  lookbackBlocks: number
  /** Assumed system+tools+memory prefix when it cannot be measured. */
  fixedPrefixTokens: number
  charsPerToken: number
}

export const DEFAULT_ECON: EconConfig = {
  cacheTtl: 'auto',
  cacheReadMultiplier: 0,
  assumedRemainingRequests: 12,
  overheadRequests: 2,
  minSavingsTokens: 3000,
  quickRatio: 1,
  sizeableTokens: 20_000,
  batchMinItems: 3,
  batchMargin: 0.1,
  pressurePercent: 80,
  lookbackBlocks: 20,
  fixedPrefixTokens: 20_000,
  charsPerToken: 3.5,
}

export const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const

/** Cache-read multiplier by model (list prices; override with cacheReadMultiplier). */
export function readMultFor(model: string | undefined, override = 0): number {
  if (override > 0) return override
  const m = (model ?? '').toLowerCase()
  if (/(fable|mythos)[-_ ]?5[-_.]?[1-9]/.test(m)) return 0.025
  if (/(opus|sonnet)[-_ ]?5[-_.]?5/.test(m)) return 0.05
  return 0.1
}

/** Everything the model needs to know about the live cache, gathered by the caller. */
export interface CacheState {
  /** Prompt-cache lifetime in force. */
  ttl: '5m' | '1h'
  /** Milliseconds since the cache was last read or written; undefined = never observed. */
  ageMs?: number
  readMult: number
}

export function writeMult(ttl: '5m' | '1h'): number {
  return ttl === '1h' ? 2 : 1.25
}

/**
 * Is the entry still alive for the next request? The lifetime runs from the START
 * of the request that last touched it and generation counts against it, so keep a
 * safety margin. Unknown age counts as live (the cautious side: a live cache is
 * the one a trim can hurt).
 */
export function isLive(c: CacheState, marginMs = 60_000): boolean {
  if (c.ageMs === undefined) return true
  return c.ageMs < TTL_MS[c.ttl] - marginMs
}

export function tokensOf(chars: number, cfg: Pick<EconConfig, 'charsPerToken'>): number {
  return Math.max(0, Math.ceil(chars / cfg.charsPerToken))
}

export interface Reentry {
  /** Tokens before the anchor: still served from the cache. */
  anchorTokens: number
  /** Tokens from the anchor to the first changed block: unchanged but recomputed anyway. */
  gapTokens: number
  /** Tokens recomputed by the next request: context minus anchor. */
  recomputeTokens: number
  /** Content blocks between the anchor and the end of the context. */
  blocksAfterAnchor: number
  /** False when the anchor lies beyond the API's lookback: nothing in the messages can be re-entered. */
  reachable: boolean
  /** Message index of the anchor (the last message whose end is a surviving entry), -1 if none. */
  anchorMsg: number
}

export function gainShort(S: number, R: number, cache: CacheState, live: boolean): number {
  const w = writeMult(cache.ttl)
  return w * S - (live ? (w - cache.readMult) * R : 0)
}

/** Net token-equivalents saved if `n` more requests follow the trim. */
export function gain(S: number, R: number, C: number, n: number, cache: CacheState, cfg: EconConfig, live = true): number {
  const w = writeMult(cache.ttl)
  const r = cache.readMult
  return w * S + (n - 1) * r * S - (live ? (w - r) * R : 0) - cfg.overheadRequests * r * C
}

/** Requests after which the trim has paid for itself (Infinity when it never does). */
export function breakEven(S: number, R: number, C: number, cache: CacheState, cfg: EconConfig, live = true): number {
  if (S <= 0) return Infinity
  const w = writeMult(cache.ttl)
  const r = cache.readMult
  const n = 1 + ((live ? (w - r) * R : 0) + cfg.overheadRequests * r * C - w * S) / (r * S)
  return Math.max(1, Math.ceil(n))
}

export type Zone = 'good' | 'marginal' | 'costly' | 'tiny'
export type Standard = 'quick' | 'sizeable' | 'batch' | 'cold-cache' | 'none'

export interface Verdict {
  zone: Zone
  /** Which standard let it through (or `none`). */
  standard: Standard
  S: number
  /** Tokens recomputed (from the re-entry anchor). */
  R: number
  C: number
  /** Share of the context that is recomputed (R / C). */
  reach: number
  horizon: number
  shortTerm: number
  longTerm: number
  breakEvenRequests: number
  live: boolean
  reentry?: Reentry
  underPressure: boolean
  summary: string
}

export interface JudgeInput {
  S: number
  /** Tokens recomputed. If `reentry` is given its recomputeTokens is used instead. */
  R?: number
  C: number
  reentry?: Reentry
  percent?: number
  expectedRequests?: number
  /** Targets + rules in the request (a deliberate batch cleans many items at once). */
  items?: number
}

/**
 * Classify a prospective trim against the standards, in this order:
 *  cold      the cache has expired: nothing extra is recomputed   -> good if long-term >= 0
 *  quick     the first request already pays for itself (saves about as many tokens as it
 *            forces the cache to recompute) AND the long-term gain is >= 0   -> good
 *  sizeable  saves >= sizeableTokens: the quick ratio is waived;
 *            the long-term gain must still be >= 0                -> good
 *  batch     a deliberate multi-item cleanup: long-term gain must
 *            clear a margin of the recompute cost                 -> good
 *  otherwise marginal (pays back within 3x the expected requests; advisory, `force` overrides)
 *            or costly (does not; it waits until the cache has expired). Under context pressure each
 *            drops one step. Below minSavingsTokens it is `tiny`.
 */
export function judge(input: JudgeInput, cache: CacheState, cfg: EconConfig): Verdict {
  const C = Math.max(1, input.C)
  const S = Math.max(0, input.S)
  const R = Math.min(C, Math.max(S, input.reentry?.recomputeTokens ?? input.R ?? S))
  const N = input.expectedRequests ?? cfg.assumedRemainingRequests
  const live = isLive(cache)
  const short = gainShort(S, R, cache, live)
  const gN = gain(S, R, C, N, cache, cfg, live)
  const gHi = gain(S, R, C, N * 3, cache, cfg, live)
  const be = breakEven(S, R, C, cache, cfg, live)
  const pressure = input.percent !== undefined && input.percent >= cfg.pressurePercent
  const items = input.items ?? 0
  const w = writeMult(cache.ttl)

  let zone: Zone
  let standard: Standard = 'none'
  if (S < cfg.minSavingsTokens) {
    zone = 'tiny'
  } else if (!live && gN >= 0) {
    zone = 'good'
    standard = 'cold-cache'
  } else if (live && w * S >= cfg.quickRatio * (w - cache.readMult) * R && gN >= 0) {
    zone = 'good'
    standard = 'quick'
  } else if (live && S >= cfg.sizeableTokens && gN >= 0) {
    zone = 'good'
    standard = 'sizeable'
  } else if (live && items >= cfg.batchMinItems && gN >= cfg.batchMargin * w * R) {
    zone = 'good'
    standard = 'batch'
  } else if (gHi >= 0) {
    zone = 'marginal'
  } else {
    zone = 'costly'
  }
  if (pressure) {
    if (zone === 'marginal') zone = 'good'
    else if (zone === 'costly') zone = 'marginal'
  }

  const reach = R / C
  const beText = Number.isFinite(be) ? `${be} request${be === 1 ? '' : 's'}` : 'never'
  const where = input.reentry
    ? input.reentry.reachable
      ? `cache re-entry ${fmtTok(input.reentry.gapTokens)} tok before the first change`
      : `first change is ${input.reentry.blocksAfterAnchor} blocks from the end, beyond the API's ${cfg.lookbackBlocks}-block lookback, so the whole conversation is reprocessed`
    : 'cache re-entry at the first change'
  const summary =
    `saves ≈${fmtTok(S)} tok but forces ≈${fmtTok(R)} tok (${Math.round(reach * 100)}% of the context) to be recomputed at ${w}x [${where}]` +
    `${live ? '' : '; cache already expired, so that cost is paid anyway'}; ` +
    `first request ${short >= 0 ? '+' : '-'}${fmtTok(Math.abs(short))}, over ${N} requests ${gN >= 0 ? '+' : '-'}${fmtTok(Math.abs(gN))} tok-eq; break-even ${beText}` +
    (pressure ? `; context at ${input.percent}%` : '')
  return {
    zone,
    standard,
    S,
    R,
    C,
    reach,
    horizon: N,
    shortTerm: short,
    longTerm: gN,
    breakEvenRequests: be,
    live,
    ...(input.reentry ? { reentry: input.reentry } : {}),
    underPressure: pressure,
    summary,
  }
}

/** Text the model reads when the guard refuses a trim. */
export function adviceFor(v: Verdict, cfg: EconConfig): string {
  const head = `Trim NOT queued (prompt-cache cost-benefit): ${v.summary}.`
  if (v.zone === 'tiny') {
    return `${head} It frees under ${fmtInt(cfg.minSavingsTokens)} tokens — not worth a reload. Trim only large, finished-with results; re-call with force:true only if you have a reason the numbers miss.`
  }
  if (v.reentry && !v.reentry.reachable) {
    const force = v.zone === 'marginal' ? ' If freeing space matters more than cache cost, re-call with force:true.' : ''
    return `${head} Anything that far back invalidates the cache for the whole conversation. Restrict the trim to the most recent results (inspect_session marks the best set with ★), or — only if this is a deliberate, large clean-up of many items — include enough in one call that the long-term numbers add up.${force}`
  }
  if (v.zone === 'marginal') {
    return `${head} It would only pay back after about ${v.breakEvenRequests} more requests (assumed ${v.horizon}). Options: (1) narrow it to the newest large items (★ in inspect_session); (2) pass expected_remaining_requests if you truly expect a longer run; (3) re-call with force:true if freeing space matters more than cache cost.`
  }
  return `${head} This reaches too far back for what it saves, so it will wait until it is free (the prompt cache has expired).`
}
