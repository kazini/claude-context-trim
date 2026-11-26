// Shared types. Pure data: nothing in hooks/lib touches `$`.

export type TrimMode = 'stub' | 'summary' | 'delete'
export type Role = 'user' | 'assistant'

/** What the model sends for one entry of `tool_targets`. */
export interface ToolTargetInput {
  id: string
  mode?: TrimMode
  replacement?: string
}

/** What the model sends for one entry of `regex_rules`. */
export interface RegexRuleInput {
  pattern: string
  flags?: string
  scope_tool_ids?: string[]
  scope_roles?: Role[]
  mode?: TrimMode
  replacement?: string
}

/** The raw arguments of a trim_session call. */
export interface TrimParams {
  tool_targets?: ToolTargetInput[]
  regex_rules?: RegexRuleInput[]
  session_note?: string
  /** Override the cost-benefit advisory (never overrides the user-confirmation gate). */
  force?: boolean
  /** How many more model requests the agent expects to make; feeds the break-even model. */
  expected_remaining_requests?: number
}

export interface Target {
  id: string
  mode: TrimMode
  replacement?: string
}

export interface Rule {
  pattern: string
  flags: string
  scopeToolIds?: string[]
  scopeRoles?: Role[]
  mode: TrimMode
  replacement?: string
}

/** A validated, normalised request: what is queued in `pendingTrimRequest`. */
export interface TrimRequest {
  targets: Target[]
  rules: Rule[]
  note: string
}

export interface StubbedItem {
  id: string
  tool: string
  label: string
  lines: number
  chars: number
  mode: 'stub' | 'summary'
}

export interface DeletedItem {
  id: string
  tool: string
  label: string
  chars: number
}

export interface RuleOutcome {
  pattern: string
  matches: number
  blocks: number
  removedChars: number
  skippedBlocks: number
}

/** What actually happened to the transcript (as opposed to the pre-flight estimate). */
export interface TrimReport {
  stubbed: StubbedItem[]
  deleted: DeletedItem[]
  alreadyTrimmed: string[]
  rules: RuleOutcome[]
  collapsedTrimCalls: number
  /** Earlier trim_session calls (all their flags resolved) that were removed, or are no longer in the transcript. */
  settledCleared: string[]
  thinkingBlocksStripped: number
  linesRemoved: number
  parentLinksRepaired: number
  savedChars: number
  /** True when anything other than the trim_session turn itself was modified. */
  changed: boolean
}

export type TranscriptResult =
  | { ok: true; lines: string[]; changedFrom: number; report: TrimReport }
  | { ok: false; error: string }

/** The subset of `SessionMessage` this plugin reads (structurally compatible). */
export interface MsgToolUse {
  tool_use_id: string
  tool: string
  input: Record<string, unknown>
  text?: string
  isError?: boolean
}
export interface MsgToolResult {
  tool_use_id: string
  text?: string
  isError?: boolean
}
export interface Msg {
  role: Role
  text: string
  toolUses: MsgToolUse[]
  toolResults?: MsgToolResult[]
  uuid?: string
}

export interface UsageLike {
  tokens?: number
  window: number
  percent?: number
  /** Token counts the last API response reported (session.usage breakdown.apiUsage). */
  apiUsage?: {
    input_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  } | null
}
