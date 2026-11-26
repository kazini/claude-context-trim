/** Number formatting and text measuring shared by every module. */

/** 3420 -> "3,420" (no Intl: the hooks environment is not guaranteed to have it). */
export function fmtInt(n: number): string {
  const s = String(Math.round(n))
  const neg = s.startsWith('-')
  const digits = neg ? s.slice(1) : s
  const out = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return neg ? '-' + out : out
}

/** 21400 -> "21.4k", 950 -> "950". */
export function fmtTok(n: number): string {
  const v = Math.round(n)
  if (Math.abs(v) < 1000) return String(v)
  const k = v / 1000
  return (Math.abs(k) >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, '')) + 'k'
}

/** Lines in a text; one trailing newline terminates the last line rather than starting another. */
export function countLines(text: string): number {
  if (text === '') return 0
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length
}

const encoder = new TextEncoder()
export function byteLength(s: string): number {
  return encoder.encode(s).length
}

export function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

export function jsonLength(v: unknown): number {
  try {
    return JSON.stringify(v ?? null).length
  } catch {
    return 0
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Short, readable label for a tool call: Read(src/auth.ts), Bash(npm test)… */
export function toolLabel(tool: string, input: Record<string, unknown> | undefined): string {
  // mcp__<plugin>__<tool> -> <tool>
  const m = /^mcp__.+?__(.+)$/.exec(tool)
  const short = m && m[1] ? m[1] : tool
  const keys = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'prompt']
  if (input) {
    for (const k of keys) {
      const v = input[k]
      if (typeof v !== 'string' || v.length === 0) continue
      // A path is identified by its END (the file name); a command or pattern by its start.
      const flat = v.replace(/\s+/g, ' ').trim()
      return `${short}(${(k === 'file_path' || k === 'path') && flat.length > 48 ? `…${flat.slice(-47)}` : oneLine(v, 48)})`
    }
  }
  return short
}
