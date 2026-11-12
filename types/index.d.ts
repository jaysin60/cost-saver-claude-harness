export type CallStatus = 'running' | 'ok' | 'error' | 'denied' | 'aborted'

/** One tool call, in whichever loop ran it. */
export type FlowCall = {
  id: string
  /** 'main' or the subagent's id. */
  agent: string
  tool: string
  label: string
  startedAt: number
  endedAt: number | null
  status: CallStatus
}

export type AgentState = 'running' | 'idle' | 'done' | 'failed' | 'aborted'

/** The main loop, or one subagent / teammate. */
export type FlowAgent = {
  id: string
  parentId: string | null
  type: string
  description: string
  /** The Agent tool call that spawned it. */
  spawnCallId: string | null
  /** The model id it runs on, once known. */
  model: string | null
  isBackground: boolean
  startedAt: number
  endedAt: number | null
  status: AgentState
  calls: number
  errors: number
}

/** A stretch of time a loop was working (one turn). */
export type FlowSpan = {
  agent: string
  startedAt: number
  endedAt: number | null
}

export type Flow = {
  agents: FlowAgent[]
  calls: FlowCall[]
  spans: FlowSpan[]
  startedAt: number
  totalCalls: number
}

/** 'flow' is the orchestration dashboard; 'tree' the text list. */
export type FlowView = 'flow' | 'tree'

export type PlanStatus = 'pending' | 'in_progress' | 'completed'

/** The main loop's task list (desktop plan or TodoWrite), for the progress bar. */
export type Plan = {
  items: { content: string; status: PlanStatus }[]
}

/** Tokens one model used across every turn that ran on it. */
export type ModelTokens = {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  turns: number
}

/** Session-level figures for the dashboard. */
export type SessionStats = {
  /** What /cost totals, when the host keeps a ledger. */
  usd: number | null
  /** The main context window's fill, in percent. */
  contextPct: number | null
  /** The person's latest prompt. */
  prompt: string
  /** Main-loop turns so far. */
  turns: number
}

/** A finished run, kept in $.store so a later session can replay it. */
export type Snapshot = {
  sessionId: string
  savedAt: number
  flow: Flow
  plan: Plan
  tokens: ModelTokens[]
  stats: SessionStats
}

/** Playback of a run: `pos` is milliseconds into the gap-compressed timeline. */
export type Replay = {
  on: boolean
  playing: boolean
  pos: number
  speed: number
  source: 'current' | 'previous'
}

declare module 'claude-code' {
  interface PluginState {
    'agent-flow': {
      flow: Shaped<Flow>
      view: FlowView
      tick: number
      plan: Plan
      tokens: ModelTokens[]
      stats: SessionStats
      /** Whether the main session's own tool calls are expanded. */
      toolsOpen: boolean
      replay: Replay
      /** The previous session's run, loaded from $.store at start. */
      previous: Shaped<Snapshot | null>
    }
  }
}
