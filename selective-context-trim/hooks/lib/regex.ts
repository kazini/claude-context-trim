import { countLines, fmtInt } from './format.ts'
import type { TrimMode } from './types.ts'

/**
 * Regexes run in-process, on Claude Code's own thread, and a JS regex cannot be
 * interrupted. So text above this size is never matched (it is reported as skipped).
 */
export const MAX_REGEX_INPUT_CHARS = 1_500_000

/** Only the flags that are safe and meaningful for a text replace. `g` is always added. */
export function normalizeFlags(flags: string | undefined): string {
  const seen = new Set<string>()
  for (const ch of flags ?? '') if ('gimsu'.includes(ch)) seen.add(ch)
  seen.add('g')
  return [...seen].join('')
}

export function compileRule(pattern: string, flags: string | undefined): RegExp {
  return new RegExp(pattern, normalizeFlags(flags))
}

export function stubForMatch(match: string): string {
  return `[Trimmed: ${fmtInt(countLines(match))} lines / ${fmtInt(match.length)} chars matched]`
}

export function summaryText(replacement: string): string {
  return `[Trimmed — Summary: ${replacement}]`
}

export interface TextRuleResult {
  text: string
  matches: number
  /** Net characters removed (matched length minus replacement length). */
  removedChars: number
  skipped: boolean
}

/**
 * Apply one rule to one decoded string. Zero-length matches are ignored, so a
 * pattern such as `^` or `x*` can never insert a stub at every position.
 */
export function applyRuleToText(
  text: string,
  re: RegExp,
  mode: TrimMode,
  replacement: string | undefined,
): TextRuleResult {
  if (text.length > MAX_REGEX_INPUT_CHARS) {
    return { text, matches: 0, removedChars: 0, skipped: true }
  }
  let matches = 0
  let removed = 0
  re.lastIndex = 0
  const out = text.replace(re, (...args: unknown[]) => {
    const m = args[0] as string
    if (m.length === 0) return m
    matches += 1
    const rep =
      mode === 'delete' ? '' : mode === 'summary' ? summaryText(replacement ?? '') : stubForMatch(m)
    removed += m.length - rep.length
    return rep
  })
  re.lastIndex = 0
  return { text: out, matches, removedChars: removed, skipped: false }
}
