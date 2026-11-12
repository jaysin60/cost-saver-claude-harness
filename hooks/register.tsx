import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, Timer, TurnUsage } from 'claude-code'

import type {
  AgentState,
  CallStatus,
  Flow,
  FlowAgent,
  FlowCall,
  FlowView,
  ModelTokens,
  Plan,
  PlanStatus,
  Replay,
  SessionStats,
  Snapshot,
} from '../types'

// ─── constants ──────────────────────────────────────────────────────────────

const PANE = 'agent-flow'
const TITLE = 'Agent flow'
const MAIN = 'main'
const MAX_CALLS = 300
const MAX_SPANS = 200
const MAX_AGENTS = 60
const TICK_MS = 1000
const LOG_ROWS = 40

const MAIN_AGENT: FlowAgent = {
  id: MAIN,
  parentId: null,
  type: 'main',
  description: 'Main session',
  spawnCallId: null,
  model: null,
  isBackground: false,
  startedAt: 0,
  endedAt: null,
  status: 'idle',
  calls: 0,
  errors: 0,
}

const EMPTY: Flow = {
  agents: [MAIN_AGENT],
  calls: [],
  spans: [],
  startedAt: 0,
  totalCalls: 0,
}

const NO_STATS: SessionStats = { usd: null, contextPct: null, prompt: '', turns: 0 }

// Bump the shape tag whenever Flow's fields change: it declines what an
// earlier version of this code stored, which outlives a reload.
const flow = atom({ plugin: 'agent-flow', key: 'flow' } as const, EMPTY, {
  shape: 'flow-1',
})
const view = atom({ plugin: 'agent-flow', key: 'view' } as const, 'flow' as FlowView)
const tick = atom({ plugin: 'agent-flow', key: 'tick' } as const, 0)
const planAtom = atom({ plugin: 'agent-flow', key: 'plan' } as const, { items: [] } as Plan)
const tokensAtom = atom({ plugin: 'agent-flow', key: 'tokens' } as const, [] as ModelTokens[])
const statsAtom = atom({ plugin: 'agent-flow', key: 'stats' } as const, NO_STATS)
const toolsOpenAtom = atom({ plugin: 'agent-flow', key: 'toolsOpen' } as const, false)
const NO_REPLAY: Replay = { on: false, playing: false, pos: 0, speed: 5, source: 'current' }
const replayAtom = atom({ plugin: 'agent-flow', key: 'replay' } as const, NO_REPLAY)
const previousAtom = atom(
  { plugin: 'agent-flow', key: 'previous' } as const,
  null as Snapshot | null,
  { shape: 'snapshot-1' },
)
const STORE_KEY = 'lastRun'
/** Idle stretches longer than this are cut to this length in a replay. */
const MAX_GAP = 2000
const REPLAY_TICK = 200
const SPEEDS = [2, 5, 20]

// ─── palette: bright 400-level hues that read well on dark backgrounds ──────

const C = {
  sky: '#38BDF8',
  emerald: '#34D399',
  amber: '#FBBF24',
  violet: '#A78BFA',
  cyan: '#22D3EE',
  pink: '#F472B6',
  lime: '#A3E635',
  slate: '#94A3B8',
  rose: '#FB7185',
  orange: '#FB923C',
  teal: '#2DD4BF',
  gold: '#FCD34D',
  /** Borders of anything idle or finished. */
  line: '#475569',
  /** Text on a bright chip. */
  ink: '#0F172A',
  /** A faint card fill that works on dark and light alike. */
  card: '#94A3B814',
}
const OK = C.emerald
const WARN = C.amber
const ERR = C.rose
const LIVE = C.orange

// ─── text helpers ───────────────────────────────────────────────────────────

function cut(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  if (max <= 1) return '…'
  return chars.slice(0, max - 1).join('') + '…'
}

function oneLine(text: string, max: number): string {
  return cut(text.replace(/\s+/g, ' ').trim(), max)
}

function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function fmtDur(ms: number): string {
  const v = Math.max(0, ms)
  if (v < 1000) return `${Math.round(v)}ms`
  if (v < 60_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}s`
  const m = Math.floor(v / 60_000)
  const s = Math.round((v % 60_000) / 1000)
  if (m < 60) return s ? `${m}m${s}s` : `${m}m`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

function fmtCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`
}

/** Elapsed since the session began, as a log timestamp: +mm:ss or h:mm:ss. */
function fmtStamp(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(r)}` : `+${two(m)}:${two(r)}`
}

// ─── tools: names, labels, categories ───────────────────────────────────────

const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent', 'requestMeta'])

function labelFor(input: unknown): string {
  const e = input as Record<string, unknown>
  const str = (k: string): string => {
    const v = e[k]
    return typeof v === 'string' ? v : ''
  }
  const tool = String(e.tool)
  let text = ''
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      text = str('description') || str('command')
      break
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      text = baseName(str('file_path'))
      break
    case 'NotebookEdit':
      text = baseName(str('notebook_path'))
      break
    case 'Grep':
    case 'Glob':
      text = str('pattern')
      break
    case 'Agent':
    case 'Task':
      text = str('description') || str('subagent_type')
      break
    case 'WebFetch':
      text = hostOf(str('url'))
      break
    case 'WebSearch':
    case 'ToolSearch':
      text = str('query')
      break
    case 'Skill':
      text = str('skill')
      break
    default:
      for (const [k, v] of Object.entries(e)) {
        if (RESERVED.has(k)) continue
        if (typeof v === 'string' && v.trim() !== '') {
          text = v
          break
        }
      }
  }
  return oneLine(text, 80)
}

function shortTool(tool: string): string {
  if (!tool.startsWith('mcp__')) return tool
  const parts = tool.split('__')
  const server = (parts[1] ?? '').replace(/^plugin_/, '')
  const name = parts.slice(2).join('__')
  return name || server
}

/** The session's own bookkeeping: counted, but left out of the map and log. */
function isBookkeeping(tool: string): boolean {
  return tool.startsWith('mcp__ccd_') || tool === 'SubagentHandback' || tool === 'ToolSearch'
}

function isAgentTool(tool: string): boolean {
  return tool === 'Agent' || tool === 'Task'
}

type Cat = 'read' | 'edit' | 'exec' | 'agent' | 'web' | 'mcp' | 'plan' | 'other'

const CATS: Record<Cat, { color: string; name: string }> = {
  read: { color: C.sky, name: 'Read/search' },
  edit: { color: C.emerald, name: 'Edit/write' },
  exec: { color: C.amber, name: 'Shell' },
  agent: { color: C.violet, name: 'Agent' },
  web: { color: C.cyan, name: 'Web' },
  mcp: { color: C.pink, name: 'MCP' },
  plan: { color: C.lime, name: 'Skill/plan' },
  other: { color: C.slate, name: 'Other' },
}
const CAT_ORDER: Cat[] = ['read', 'edit', 'exec', 'agent', 'web', 'mcp', 'plan', 'other']

function categoryOf(tool: string): Cat {
  if (tool.startsWith('mcp__ccd_')) return 'plan'
  if (tool.startsWith('mcp__')) return 'mcp'
  switch (tool) {
    case 'Read':
    case 'Grep':
    case 'Glob':
    case 'LS':
    case 'LSP':
      return 'read'
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit'
    case 'Bash':
    case 'PowerShell':
    case 'BashOutput':
    case 'KillShell':
    case 'Monitor':
      return 'exec'
    case 'Agent':
    case 'Task':
    case 'SendMessage':
    case 'TaskStop':
    case 'SubagentHandback':
      return 'agent'
    case 'WebFetch':
    case 'WebSearch':
      return 'web'
    case 'Skill':
    case 'ToolSearch':
    case 'TodoWrite':
    case 'EnterPlanMode':
    case 'ExitPlanMode':
    case 'AskUserQuestion':
      return 'plan'
    default:
      return 'other'
  }
}

// ─── models ─────────────────────────────────────────────────────────────────

const MODEL_COLOR: Record<string, string> = {
  fable: C.gold,
  mythos: C.gold,
  opus: C.violet,
  sonnet: C.orange,
  haiku: C.teal,
}

function modelFamily(id: string | null): string | null {
  if (!id) return null
  const m = /(fable|mythos|opus|sonnet|haiku)/i.exec(id)
  return m?.[1]?.toLowerCase() ?? null
}

/** 'claude-haiku-5-5' → 'Haiku 5.5'; an alias alone → 'Haiku'. */
function prettyModel(id: string | null): string {
  if (!id) return ''
  const m = /(fable|mythos|opus|sonnet|haiku)(?:[-_ ]?(\d+)(?:[-.](\d{1,2}))?)?/i.exec(id)
  if (!m || !m[1]) return cut(id, 16)
  const fam = m[1].toLowerCase()
  const name = fam.charAt(0).toUpperCase() + fam.slice(1)
  if (!m[2] || m[2].length > 2) return name
  return `${name} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

function modelColor(id: string | null): string {
  const fam = modelFamily(id)
  return (fam && MODEL_COLOR[fam]) || C.slate
}

// ─── pure state transitions (update() may retry them, so no side effects) ──

function patchAgent(f: Flow, id: string, fn: (a: FlowAgent) => FlowAgent): Flow {
  return { ...f, agents: f.agents.map(a => (a.id === id ? fn(a) : a)) }
}

function trimAgents(agents: FlowAgent[]): FlowAgent[] {
  if (agents.length <= MAX_AGENTS) return agents
  let over = agents.length - MAX_AGENTS
  return agents.filter(a => {
    if (over > 0 && a.id !== MAIN && a.status !== 'running') {
      over -= 1
      return false
    }
    return true
  })
}

function trimCalls(calls: FlowCall[]): FlowCall[] {
  if (calls.length <= MAX_CALLS) return calls
  let over = calls.length - MAX_CALLS
  return calls.filter(c => {
    if (over > 0 && c.status !== 'running') {
      over -= 1
      return false
    }
    return true
  })
}

function hasAgent(f: Flow, id: string): boolean {
  return f.agents.some(a => a.id === id)
}

function openSpan(f: Flow, agent: string, at: number): Flow {
  if (f.spans.some(s => s.agent === agent && s.endedAt === null)) return f
  return {
    ...f,
    spans: [...f.spans, { agent, startedAt: at, endedAt: null }].slice(-MAX_SPANS),
  }
}

function closeSpan(f: Flow, agent: string, at: number): Flow {
  if (!f.spans.some(s => s.agent === agent && s.endedAt === null)) return f
  return {
    ...f,
    spans: f.spans.map(s =>
      s.agent === agent && s.endedAt === null ? { ...s, endedAt: at } : s,
    ),
  }
}

function ensureAgent(f: Flow, id: string, at: number): Flow {
  if (hasAgent(f, id)) return f
  const placeholder: FlowAgent = {
    ...MAIN_AGENT,
    id,
    parentId: MAIN,
    type: 'agent',
    description: '',
    startedAt: at,
    status: 'running',
  }
  return openSpan({ ...f, agents: trimAgents([...f.agents, placeholder]) }, id, at)
}

function setModel(f: Flow, id: string, model: string | undefined): Flow {
  if (!model) return f
  const a = f.agents.find(x => x.id === id)
  if (!a || a.model === model) return f
  return patchAgent(f, id, x => ({ ...x, model }))
}

function addCall(f: Flow, call: FlowCall): Flow {
  let g = ensureAgent(f, call.agent, call.startedAt)
  g = patchAgent(g, call.agent, a => ({ ...a, calls: a.calls + 1 }))
  return {
    ...g,
    calls: trimCalls([...g.calls.filter(c => c.id !== call.id), call]),
    totalCalls: g.totalCalls + 1,
    startedAt: g.startedAt || call.startedAt,
  }
}

function endCall(f: Flow, id: string, at: number, status: CallStatus): Flow {
  const call = f.calls.find(c => c.id === id)
  if (!call) return f
  let g: Flow = {
    ...f,
    calls: f.calls.map(c => (c.id === id ? { ...c, endedAt: at, status } : c)),
  }
  if (status === 'error' && call.status !== 'error') {
    g = patchAgent(g, call.agent, a => ({ ...a, errors: a.errors + 1 }))
  }
  return g
}

function upsertAgent(f: Flow, node: FlowAgent): Flow {
  const old = f.agents.find(a => a.id === node.id)
  if (!old) {
    return openSpan({ ...f, agents: trimAgents([...f.agents, node]) }, node.id, node.startedAt)
  }
  const merged: FlowAgent = {
    ...node,
    calls: old.calls,
    errors: old.errors,
    startedAt: Math.min(old.startedAt || node.startedAt, node.startedAt),
  }
  return openSpan(patchAgent(f, node.id, () => merged), node.id, merged.startedAt)
}

function startTurn(f: Flow, agent: string, at: number): Flow {
  // Only the main loop, or an agent we already know: engine forks
  // (compaction, memory) would otherwise each add an empty card.
  if (agent !== MAIN && !hasAgent(f, agent)) return f
  let g = patchAgent(f, agent, a => ({
    ...a,
    status: 'running',
    endedAt: null,
    startedAt: a.startedAt || at,
  }))
  g = openSpan(g, agent, at)
  return { ...g, startedAt: g.startedAt || at }
}

function endTurn(f: Flow, agent: string, at: number, state: AgentState): Flow {
  if (!hasAgent(f, agent)) return f
  const leftover: CallStatus =
    state === 'aborted' ? 'aborted' : state === 'failed' ? 'error' : 'ok'
  let g: Flow = {
    ...f,
    calls: f.calls.map(c =>
      c.agent === agent && c.status === 'running'
        ? { ...c, endedAt: at, status: leftover }
        : c,
    ),
  }
  g = patchAgent(g, agent, a => ({
    ...a,
    status: state,
    endedAt: agent === MAIN ? null : at,
  }))
  return closeSpan(g, agent, at)
}

const LIST_STATE: Record<string, AgentState> = {
  pending: 'running',
  running: 'running',
  waiting: 'idle',
  idle: 'idle',
  completed: 'done',
  failed: 'failed',
  killed: 'aborted',
}

function isEnded(state: AgentState): boolean {
  return state === 'done' || state === 'failed' || state === 'aborted'
}

/** Folds $.agent.list() into the flow; returns `f` itself when nothing changed. */
function syncAgents(f: Flow, list: readonly AgentInfo[], at: number): Flow {
  let g = f
  for (const info of list) {
    const a = g.agents.find(x => x.id === info.id)
    if (!a) continue
    const state = LIST_STATE[info.status] ?? a.status
    const type = a.type === 'agent' ? info.type : a.type
    const description = a.description || info.description
    const parentId = a.parentId === MAIN && info.parentId ? info.parentId : a.parentId
    if (
      state === a.status &&
      type === a.type &&
      description === a.description &&
      parentId === a.parentId
    ) {
      continue
    }
    g = patchAgent(g, a.id, x => ({
      ...x,
      status: state,
      type,
      description,
      parentId,
      endedAt: isEnded(state) ? (x.endedAt ?? at) : null,
    }))
    if (isEnded(state)) g = closeSpan(g, a.id, at)
  }
  return g
}

function cleared(f: Flow, at: number): Flow {
  const live = new Set(f.agents.filter(a => a.status === 'running').map(a => a.id))
  return {
    agents: f.agents
      .filter(a => a.id === MAIN || live.has(a.id))
      .map(a => ({ ...a, calls: 0, errors: 0 })),
    calls: f.calls.filter(c => c.status === 'running'),
    spans: f.spans.filter(s => s.endedAt === null),
    startedAt: at,
    totalCalls: 0,
  }
}

function isBusy(f: Flow): boolean {
  return f.calls.some(c => c.status === 'running') || f.agents.some(a => a.status === 'running')
}

function lastEventAt(f: Flow): number {
  let t = f.startedAt
  for (const c of f.calls) t = Math.max(t, c.endedAt ?? c.startedAt)
  for (const s of f.spans) t = Math.max(t, s.endedAt ?? s.startedAt)
  return t
}

function parentOf(f: Flow, a: FlowAgent): string {
  return a.parentId !== null && a.parentId !== a.id && hasAgent(f, a.parentId) ? a.parentId : MAIN
}

/** Main first, then each agent under the one that spawned it. */
function orderedAgents(f: Flow): { agent: FlowAgent; depth: number }[] {
  const children = new Map<string, FlowAgent[]>()
  for (const a of f.agents) {
    if (a.id === MAIN) continue
    const parent = parentOf(f, a)
    const list = children.get(parent) ?? []
    list.push(a)
    children.set(parent, list)
  }
  for (const list of children.values()) list.sort((x, y) => x.startedAt - y.startedAt)
  const out: { agent: FlowAgent; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (a: FlowAgent, depth: number): void => {
    if (seen.has(a.id)) return
    seen.add(a.id)
    out.push({ agent: a, depth })
    for (const c of children.get(a.id) ?? []) walk(c, depth + 1)
  }
  walk(f.agents.find(a => a.id === MAIN) ?? MAIN_AGENT, 0)
  for (const a of f.agents) if (!seen.has(a.id)) walk(a, 1)
  return out
}

function agentName(a: FlowAgent): string {
  return a.id === MAIN ? 'Main session' : a.type
}

// ─── plan, tokens ───────────────────────────────────────────────────────────

function planStatus(v: unknown): PlanStatus {
  return v === 'completed' || v === 'in_progress' ? v : 'pending'
}

/** The task list after a plan tool call, or null for any other tool. */
function planAfter(prev: Plan, tool: string, input: Record<string, unknown>): Plan | null {
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    return {
      items: input.todos.map(t => {
        const o = (t ?? {}) as Record<string, unknown>
        const status = planStatus(o.status)
        const text =
          status === 'in_progress' && typeof o.activeForm === 'string' ? o.activeForm : String(o.content ?? '')
        return { content: oneLine(text, 120), status }
      }),
    }
  }
  if (tool === 'mcp__ccd_turn__wrap_up') {
    if (prev.items.length === 0) return null
    return { items: prev.items.map(i => ({ ...i, status: 'completed' })) }
  }
  if (tool !== 'mcp__ccd_turn__update_plan') return null
  if (Array.isArray(input.items)) {
    return {
      items: input.items.map(t => {
        const o = (t ?? {}) as Record<string, unknown>
        return { content: oneLine(String(o.content ?? ''), 120), status: planStatus(o.status) }
      }),
    }
  }
  const items = prev.items.map(i => ({ ...i }))
  if (input.advance === true) {
    const i = items.findIndex(x => x.status === 'in_progress')
    const cur = items[i]
    if (cur) cur.status = 'completed'
    const nextItem = items.find((x, k) => k > i && x.status === 'pending')
    if (nextItem) nextItem.status = 'in_progress'
  }
  if (Array.isArray(input.done)) {
    for (const n of input.done) {
      const it = typeof n === 'number' ? items[n - 1] : undefined
      if (it) it.status = 'completed'
    }
  }
  if (typeof input.start === 'number') {
    const it = items[input.start - 1]
    if (it) it.status = 'in_progress'
  }
  return { items }
}

function addTokens(list: ModelTokens[], u: TurnUsage): ModelTokens[] {
  const add = {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
  }
  const i = list.findIndex(x => x.model === u.model)
  if (i < 0) return [...list, { model: u.model, ...add, turns: 1 }]
  return list.map((x, k) =>
    k === i
      ? {
          ...x,
          input: x.input + add.input,
          output: x.output + add.output,
          cacheRead: x.cacheRead + add.cacheRead,
          cacheWrite: x.cacheWrite + add.cacheWrite,
          turns: x.turns + 1,
        }
      : x,
  )
}

function totalTokens(t: ModelTokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

/** Tokens summed per model family (Sonnet, Haiku, ...), largest first. */
function tokensByFamily(list: ModelTokens[]): { label: string; color: string; n: number }[] {
  const by = new Map<string, { label: string; color: string; n: number }>()
  for (const t of list) {
    const label = prettyModel(t.model).split(' ')[0] || t.model
    const cur = by.get(label) ?? { label, color: modelColor(t.model), n: 0 }
    cur.n += totalTokens(t)
    by.set(label, cur)
  }
  return [...by.values()].filter(x => x.n > 0).sort((a, b) => b.n - a.n)
}

// ─── the session log ────────────────────────────────────────────────────────

type LogRow = {
  key: string
  at: number
  who: string
  what: string
  whatColor: string
  detail: string
  status: string
  statusColor: string
  dur: string
}

const STATUS_COLOR: Record<string, string> = {
  running: WARN,
  working: WARN,
  ok: OK,
  done: OK,
  idle: C.slate,
  error: ERR,
  failed: ERR,
  denied: C.slate,
  aborted: C.slate,
  spawn: C.violet,
}

/** Tool calls and agent starts/ends, newest first. */
function logRows(f: Flow, now: number): LogRow[] {
  const byId = new Map(f.agents.map(a => [a.id, a] as const))
  const who = (id: string) => (id === MAIN ? 'main' : (byId.get(id)?.type ?? 'agent'))
  const rows: LogRow[] = []
  for (const c of f.calls) {
    if (isBookkeeping(c.tool)) continue
    rows.push({
      key: `c-${c.id}`,
      at: c.startedAt,
      who: who(c.agent),
      what: shortTool(c.tool),
      whatColor: CATS[categoryOf(c.tool)].color,
      detail: c.label,
      status: c.status,
      statusColor: STATUS_COLOR[c.status] ?? C.slate,
      dur: fmtDur((c.endedAt ?? now) - c.startedAt),
    })
  }
  for (const a of f.agents) {
    if (a.id === MAIN) continue
    rows.push({
      key: `s-${a.id}`,
      at: a.startedAt,
      who: who(parentOf(f, a)),
      what: `→ ${a.type}`,
      whatColor: modelColor(a.model),
      detail: [prettyModel(a.model), a.description].filter(Boolean).join(' · '),
      status: 'spawn',
      statusColor: STATUS_COLOR.spawn ?? C.violet,
      dur: '',
    })
    if (a.endedAt !== null) {
      rows.push({
        key: `e-${a.id}`,
        at: a.endedAt,
        who: a.type,
        what: '← report',
        whatColor: modelColor(a.model),
        detail: `${a.calls} call${a.calls === 1 ? '' : 's'}${a.errors ? ` · ${a.errors} errors` : ''}`,
        status: a.status,
        statusColor: STATUS_COLOR[a.status] ?? C.slate,
        dur: fmtDur(a.endedAt - a.startedAt),
      })
    }
  }
  return rows.sort((x, y) => y.at - x.at).slice(0, LOG_ROWS)
}

// ─── replay: the run as it stood at any moment ──────────────────────────────

type Timeline = { real: number[]; comp: number[]; total: number }

/** Every event time, with idle gaps over MAX_GAP squeezed to MAX_GAP. */
function timeline(f: Flow): Timeline {
  const ts: number[] = []
  for (const c of f.calls) {
    ts.push(c.startedAt)
    if (c.endedAt !== null) ts.push(c.endedAt)
  }
  for (const a of f.agents) {
    if (a.id === MAIN) continue
    ts.push(a.startedAt)
    if (a.endedAt !== null) ts.push(a.endedAt)
  }
  for (const s of f.spans) {
    ts.push(s.startedAt)
    if (s.endedAt !== null) ts.push(s.endedAt)
  }
  const real = [...new Set(ts.filter(t => t > 0))].sort((a, b) => a - b)
  const comp: number[] = []
  for (let i = 0; i < real.length; i += 1) {
    const prev = real[i - 1]
    const cur = real[i] ?? 0
    comp.push(i === 0 || prev === undefined ? 0 : (comp[i - 1] ?? 0) + Math.min(MAX_GAP, cur - prev))
  }
  return { real, comp, total: comp[comp.length - 1] ?? 0 }
}

/** The real time a replay position stands for. */
function realAt(tl: Timeline, pos: number): number {
  if (tl.real.length === 0) return 0
  let i = 0
  while (i + 1 < tl.comp.length && (tl.comp[i + 1] ?? Infinity) <= pos) i += 1
  const r = tl.real[i] ?? 0
  const c = tl.comp[i] ?? 0
  const nextReal = tl.real[i + 1]
  return r + Math.min(Math.max(0, pos - c), nextReal === undefined ? 0 : nextReal - r)
}

/** The flow as it stood at real time T. */
function flowAt(f: Flow, T: number): Flow {
  const calls: FlowCall[] = f.calls
    .filter(c => c.startedAt <= T)
    .map(c => (c.endedAt !== null && c.endedAt <= T ? c : { ...c, endedAt: null, status: 'running' }))
  const counts = new Map<string, { n: number; err: number }>()
  for (const c of calls) {
    const x = counts.get(c.agent) ?? { n: 0, err: 0 }
    x.n += 1
    if (c.status === 'error') x.err += 1
    counts.set(c.agent, x)
  }
  const spans = f.spans
    .filter(s => s.startedAt <= T)
    .map(s => (s.endedAt !== null && s.endedAt <= T ? s : { ...s, endedAt: null }))
  const mainBusy = spans.some(s => s.agent === MAIN && s.endedAt === null)
  const agents: FlowAgent[] = f.agents
    .filter(a => a.id === MAIN || a.startedAt <= T)
    .map(a => {
      const k = counts.get(a.id) ?? { n: 0, err: 0 }
      if (a.id === MAIN) return { ...a, status: mainBusy ? 'running' : 'idle', calls: k.n, errors: k.err }
      const ended = a.endedAt !== null && a.endedAt <= T
      return {
        ...a,
        status: ended ? a.status : 'running',
        endedAt: ended ? a.endedAt : null,
        calls: k.n,
        errors: k.err,
      }
    })
  return { ...f, agents, calls, spans, totalCalls: calls.length }
}

function isSnapshot(v: unknown): v is Snapshot {
  const s = v as Snapshot | undefined
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof s.sessionId === 'string' &&
    Array.isArray(s.flow?.calls) &&
    Array.isArray(s.flow?.agents) &&
    Array.isArray(s.flow?.spans)
  )
}

// ─── the hooks ──────────────────────────────────────────────────────────────

let ticker: Timer | undefined
let replayTimer: Timer | undefined
let seq = 0

function stopReplayTimer(): void {
  replayTimer?.cancel()
  replayTimer = undefined
}

async function replaySource($: EngineInterface, r: Replay): Promise<Flow | null> {
  if (r.source === 'previous') return (await read($, previousAtom))?.flow ?? null
  return read($, flow)
}

async function stepReplay($: EngineInterface): Promise<void> {
  const r = await read($, replayAtom)
  const src = r.on && r.playing ? await replaySource($, r) : null
  if (!src) {
    stopReplayTimer()
    return
  }
  const total = timeline(src).total
  const pos = Math.min(total, r.pos + REPLAY_TICK * r.speed)
  await update($, replayAtom, x => ({ ...x, pos, playing: x.playing && pos < total }))
  if (pos >= total) stopReplayTimer()
}

function runReplayTimer($: EngineInterface): void {
  stopReplayTimer()
  replayTimer = $.clock.every(REPLAY_TICK, () => {
    stepReplay($).catch(() => stopReplayTimer())
  })
}

async function startReplay($: EngineInterface, source: Replay['source']): Promise<void> {
  await update($, replayAtom, r => ({ ...r, on: true, playing: true, pos: 0, source }))
  runReplayTimer($)
}

async function saveRun($: EngineInterface): Promise<void> {
  const snap: Snapshot = {
    sessionId: await $.session.id(),
    savedAt: await $.clock.now(),
    flow: await read($, flow),
    plan: await read($, planAtom),
    tokens: await read($, tokensAtom),
    stats: await read($, statsAtom),
  }
  await $.store.set(STORE_KEY, snap)
}

async function refreshStats($: EngineInterface): Promise<void> {
  let usd: number | null = null
  let contextPct: number | null = null
  try {
    const u = await $.session.usage()
    usd = u.cost ? Math.round(u.cost.usd * 100) / 100 : null
    contextPct = u.context.percent !== undefined ? Math.round(u.context.percent) : null
  } catch {
    return
  }
  const cur = await read($, statsAtom)
  if (cur.usd === usd && cur.contextPct === contextPct) return
  await update($, statsAtom, s => ({ ...s, usd, contextPct }))
}

async function pulse($: EngineInterface): Promise<void> {
  const f = await read($, flow)
  if (!isBusy(f)) return
  const t = await $.clock.now()
  await update($, tick, () => t)
  await refreshStats($).catch(() => undefined)
  let list: AgentInfo[] = []
  try {
    list = await $.agent.list()
  } catch {
    return
  }
  if (syncAgents(f, list, t) !== f) {
    await update($, flow, g => syncAgents(g, list, t))
  }
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-flow',
      description: 'Open the live agent & tool-call dashboard pane',
    })
    const t = await $.clock.now()
    await update($, flow, f => (f.startedAt ? f : { ...f, startedAt: t }))
    // The main session's model, known before any turn ends.
    try {
      const model = await $.session.model()
      await update($, flow, f => setModel(f, MAIN, model))
    } catch {
      // Not every host answers it; the first spawn or turn end fills it in.
    }
    // A run saved by another session is offered as "Previous session".
    try {
      const id = await $.session.id()
      const saved = await $.store.get(STORE_KEY)
      if (isSnapshot(saved) && saved.sessionId !== id) await update($, previousAtom, () => saved)
    } catch {
      // No saved run, or it could not be read: nothing to offer.
    }
    // A reload drops the replay timer, so playback starts paused.
    stopReplayTimer()
    await update($, replayAtom, r => ({ ...r, playing: false }))
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => {
      pulse($).catch(() => undefined)
    })
    void refreshStats($).catch(() => undefined)
    void openPane($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'agent-flow' }, async $ => {
    await openPane($)

    return { text: 'Agent flow pane opened.' }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const t = await $.clock.now()
      await update($, flow, f => cleared(f, t))
      await update($, planAtom, () => ({ items: [] }))
    } else {
      // The session is ending: keep its run for "Previous session".
      await saveRun($).catch(() => undefined)
    }

    return next(e)
  })

  // Every tool call, in the main loop and in every subagent's.
  on('tool.call', async ($, e, next) => {
    seq += 1
    const id = e.tool_use_id ?? `call-${seq}`
    const tool = String(e.tool)
    const t0 = await $.clock.now()
    const call: FlowCall = {
      id,
      agent: e.agentId ?? MAIN,
      tool,
      label: labelFor(e),
      startedAt: t0,
      endedAt: null,
      status: 'running',
    }
    const started = update($, flow, f => addCall(f, call)).catch(() => undefined)
    if (e.agentId === undefined) {
      const input = e as unknown as Record<string, unknown>
      const prev = await read($, planAtom)
      if (planAfter(prev, tool, input) !== null) {
        await update($, planAtom, p => planAfter(p, tool, input) ?? p).catch(() => undefined)
      }
    }
    let status: CallStatus = 'error'
    try {
      const ran = await next(e)
      status = ran.deny !== undefined ? 'denied' : ran.isError ? 'error' : 'ok'
      return ran
    } finally {
      const t1 = await $.clock.now()
      await started
      await update($, flow, f => endCall(f, id, t1, status)).catch(() => undefined)
    }
  })

  // A subagent (or teammate) starting: links it to the Agent call and parent.
  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if (ran.agentId !== undefined) {
      const t = await $.clock.now()
      const node: FlowAgent = {
        id: ran.agentId,
        parentId: e.parentAgentId ?? MAIN,
        type: e.subagentType,
        description: oneLine(e.description, 120),
        spawnCallId: e.tool_use_id || null,
        model: ran.model || null,
        isBackground: e.background,
        startedAt: t,
        endedAt: null,
        status: 'running',
        calls: 0,
        errors: 0,
      }
      await update($, flow, f =>
        // The spawner's own model rides along: the one way to learn main's early.
        setModel(upsertAgent(f, node), e.parentAgentId ?? MAIN, e.parentModel),
      ).catch(() => undefined)
    }

    return ran
  })

  on('turn.start', async ($, e, next) => {
    const t = await $.clock.now()
    const agent = e.agentId ?? MAIN
    await update($, flow, f => startTurn(f, agent, t)).catch(() => undefined)
    if (agent === MAIN) {
      // New live work ends any replay on screen.
      const r = await read($, replayAtom)
      if (r.on) {
        stopReplayTimer()
        await update($, replayAtom, x => ({ ...x, on: false, playing: false })).catch(() => undefined)
      }
      const text = e.text.trim()
      await update($, statsAtom, s => ({
        ...s,
        turns: s.turns + 1,
        prompt: text ? oneLine(text, 400) : s.prompt,
      })).catch(() => undefined)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const t = await $.clock.now()
    const agent = e.agentId ?? MAIN
    const state: AgentState =
      e.reason === 'aborted'
        ? 'aborted'
        : e.reason === 'answer'
          ? agent === MAIN
            ? 'idle'
            : 'done'
          : 'failed'
    await update($, flow, f => setModel(endTurn(f, agent, t, state), agent, e.usage?.model)).catch(
      () => undefined,
    )
    const usage = e.usage
    if (usage) await update($, tokensAtom, list => addTokens(list, usage)).catch(() => undefined)
    await refreshStats($).catch(() => undefined)
    // Each finished main turn saves the run, for replay from a later session.
    if (agent === MAIN) await saveRun($).catch(() => undefined)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const isTerm = e.surface === 'terminal'
    const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
    const liveFlow = await read($, flow)
    const chosen = await read($, view)
    const livePlan = await read($, planAtom)
    const liveTokens = await read($, tokensAtom)
    const liveStats = await read($, statsAtom)
    const toolsOpen = await read($, toolsOpenAtom)
    const replay = await read($, replayAtom)
    const previous = await read($, previousAtom)
    const mode: FlowView = chosen === 'tree' ? 'tree' : 'flow'
    const liveBusy = isBusy(liveFlow)
    // During a replay everything below is drawn from the run as it stood then.
    const usePrev = replay.on && replay.source === 'previous' && previous !== null
    const srcFlow = usePrev && previous ? previous.flow : liveFlow
    const tl = replay.on ? timeline(srcFlow) : null
    const T = tl ? realAt(tl, replay.pos) : 0
    const f = tl ? flowAt(srcFlow, T) : liveFlow
    const plan = usePrev && previous ? previous.plan : livePlan
    const tokens = usePrev && previous ? previous.tokens : liveTokens
    const stats = usePrev && previous ? previous.stats : liveStats
    // Only the tree shows live durations, so only it redraws on each tick.
    const ticked = mode === 'tree' && !tl ? await read($, tick) : 0
    const busy = isBusy(f)
    const now = tl ? T : busy ? Math.max(ticked, lastEventAt(f)) : lastEventAt(f)
    const cols = e.props.bodyColumns || e.viewport?.columns || 60

    // Fills with a translucent color: not on a terminal, which has no alpha.
    const wash = (hex: string) => (isTerm ? {} : { backgroundColor: `${hex}1F` })
    const cardFill = isTerm ? {} : { backgroundColor: C.card }

    const subs = f.agents.filter(a => a.id !== MAIN)
    const activeSubs = subs.filter(a => a.status === 'running').length
    const running = f.calls.filter(c => c.status === 'running' && !isBookkeeping(c.tool)).length
    const errors = f.agents.reduce((n, a) => n + a.errors, 0)
    const families = tokensByFamily(tokens)
    const tokenTotal = families.reduce((n, x) => n + x.n, 0)

    const setMode = (m: FlowView) => () => {
      void update($, view, () => m)
    }
    const clear = () => {
      void $.clock.now().then(t => update($, flow, g => cleared(g, t)))
    }
    const toggleTools = () => {
      void update($, toolsOpenAtom, v => !v)
    }
    const openTranscript = (a: FlowAgent) => () => {
      void $.ui.view(a.id === MAIN ? {} : { agentId: a.id })
    }

    // ── a progress bar: an Svg strip on desktop, block characters elsewhere
    const bar = (key: string, segs: { frac: number; color: string }[], alt: string) => {
      if (Svg === undefined) {
        const n = Math.max(10, Math.min(40, cols - 4))
        let used = 0
        const parts = segs.map(s => {
          const k = Math.max(0, Math.min(n - used, Math.round(s.frac * n)))
          used += k
          return { k, color: s.color }
        })
        return (
          <Box key={key} flexDirection="row">
            {parts.map(p => (
              <Text color={p.color}>{'█'.repeat(p.k)}</Text>
            ))}
            <Text dimColor>{'░'.repeat(Math.max(0, n - used))}</Text>
          </Box>
        )
      }
      const W = 1600
      let x = 0
      const rects = segs
        .map(s => {
          const w = Math.max(0, s.frac) * W
          const r = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="12" fill="${s.color}"/>`
          x += w
          return r
        })
        .join('')
      const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 12" width="${W}" height="12" preserveAspectRatio="none"><rect width="${W}" height="12" fill="${C.slate}" fill-opacity=".18"/>${rects}</svg>`
      return (
        <Box key={key}>
          <Svg source={source} alt={alt} height={8} />
        </Box>
      )
    }

    // ── header: live state + view switch, or the replay controls
    const replayFrom = (source: Replay['source']) => () => {
      void startReplay($, source)
    }
    const playPause = () => {
      void (async () => {
        const r = await read($, replayAtom)
        if (r.playing) {
          stopReplayTimer()
          await update($, replayAtom, x => ({ ...x, playing: false }))
          return
        }
        const src = await replaySource($, r)
        const total = src ? timeline(src).total : 0
        await update($, replayAtom, x => ({ ...x, playing: true, pos: x.pos >= total ? 0 : x.pos }))
        runReplayTimer($)
      })()
    }
    const cycleSpeed = () => {
      void update($, replayAtom, x => ({
        ...x,
        speed: SPEEDS[(SPEEDS.indexOf(x.speed) + 1) % SPEEDS.length] ?? 5,
      }))
    }
    const exitReplay = () => {
      stopReplayTimer()
      void update($, replayAtom, x => ({ ...x, on: false, playing: false }))
    }
    const canReplay = !liveBusy && liveFlow.calls.length > 0
    const liveHeader = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" columnGap={2} rowGap={1}>
        <Text size="heading" weight="bold" color={busy ? LIVE : C.slate}>
          {busy ? '● Live' : '○ Idle'}
        </Text>
        <Box flexDirection="row" columnGap={1} flexWrap="wrap" rowGap={1}>
          {canReplay && <Button key="r-start" label="▶ Replay" onPress={replayFrom('current')} />}
          {previous !== null && !liveBusy && (
            <Button key="r-prev" label="▶ Previous session" onPress={replayFrom('previous')} />
          )}
          <Button key="v-flow" label="Dashboard" variant={mode === 'flow' ? 'primary' : 'secondary'} onPress={setMode('flow')} />
          <Button key="v-tree" label="Tree" variant={mode === 'tree' ? 'primary' : 'secondary'} onPress={setMode('tree')} />
          <Button key="clear" label="Clear" onPress={clear} />
        </Box>
      </Box>
    )
    const atEnd = tl !== null && replay.pos >= tl.total
    const replayHeader = tl ? (
      <Box flexDirection="column" borderStyle="round" borderColor={C.violet} paddingX={1} {...wash(C.violet)}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" columnGap={2} rowGap={1}>
          <Text size="heading" weight="bold" color={C.violet}>
            {replay.playing ? '▶ Replaying' : atEnd ? '■ Replay finished' : '⏸ Paused'}
            {usePrev ? ' · previous session' : ''}
          </Text>
          <Box flexDirection="row" columnGap={1}>
            <Button
              key="r-play"
              variant="primary"
              label={replay.playing ? '⏸ Pause' : atEnd ? '↺ Again' : '▶ Play'}
              onPress={playPause}
            />
            <Button key="r-speed" label={`${replay.speed}× speed`} onPress={cycleSpeed} />
            <Button key="r-exit" label="Exit" onPress={exitReplay} />
          </Box>
        </Box>
        {bar('replay-bar', [{ frac: tl.total ? replay.pos / tl.total : 0, color: C.violet }], 'Replay position')}
        <Text size="caption" dimColor>
          {`${fmtStamp(T - srcFlow.startedAt)} of ${fmtStamp(lastEventAt(srcFlow) - srcFlow.startedAt)} · idle gaps over ${MAX_GAP / 1000}s are skipped`}
        </Text>
      </Box>
    ) : null
    const header = replayHeader ?? liveHeader

    // ── big-number tiles
    const tile = (key: string, value: string, label: string, color?: string, minWidth = 11) => (
      <Box
        key={key}
        flexDirection="column"
        flexGrow={1}
        minWidth={minWidth}
        borderStyle="round"
        borderColor={color ?? C.line}
        paddingX={1}
        {...cardFill}
      >
        <Text size="title" weight="bold" {...(color ? { color } : {})}>
          {value}
        </Text>
        <Text size="caption" dimColor>
          {label}
        </Text>
      </Box>
    )
    const tiles = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
        {tile('k-calls', fmtCount(f.totalCalls), 'tool calls')}
        {tile('k-run', String(running), 'running now', running > 0 ? WARN : undefined)}
        {tile('k-agents', `${activeSubs}/${subs.length}`, 'agents active', activeSubs > 0 ? OK : undefined)}
        {tile('k-err', String(errors), 'errors', errors > 0 ? ERR : undefined)}
        {tile('k-tok', tokenTotal ? fmtCount(tokenTotal) : '—', 'tokens')}
        {tile('k-cost', stats.usd !== null ? `$${stats.usd.toFixed(2)}` : '—', 'session cost')}
      </Box>
    )

    // ── progress: the plan, and where the tokens went
    const done = plan.items.filter(i => i.status === 'completed').length
    const step = plan.items.find(i => i.status === 'in_progress')
    const planBlock =
      plan.items.length > 0 ? (
        <Box key="plan" flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold>
              Progress {done}/{plan.items.length}
            </Text>
            <Text dimColor>{Math.round((done / plan.items.length) * 100)}%</Text>
          </Box>
          {bar(
            'plan-bar',
            [
              { frac: done / plan.items.length, color: OK },
              { frac: step ? 1 / plan.items.length : 0, color: WARN },
            ],
            `${done} of ${plan.items.length} steps done`,
          )}
        </Box>
      ) : (
        <Box key="plan" flexDirection="column">
          <Text bold>Progress</Text>
          {bar(
            'calls-bar',
            (() => {
              const total = Math.max(1, f.calls.length)
              const ok = f.calls.filter(c => c.status === 'ok').length
              const bad = f.calls.filter(c => c.status === 'error').length
              const live = f.calls.filter(c => c.status === 'running').length
              return [
                { frac: ok / total, color: OK },
                { frac: live / total, color: WARN },
                { frac: bad / total, color: ERR },
              ]
            })(),
            'Tool calls by outcome',
          )}
          <Text size="caption" dimColor>
            No task list yet: calls done, running and failed.
          </Text>
        </Box>
      )
    const tokenBlock =
      tokenTotal > 0 ? (
        <Box key="tok" flexDirection="column">
          <Text bold>Tokens by model</Text>
          {bar(
            'tok-bar',
            families.map(x => ({ frac: x.n / tokenTotal, color: x.color })),
            'Share of tokens per model',
          )}
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {families.map(x => (
              <Text color={x.color}>
                ● {x.label} {Math.round((x.n / tokenTotal) * 100)}% · {fmtCount(x.n)}
              </Text>
            ))}
          </Box>
        </Box>
      ) : null

    const chip = (model: string | null, active: boolean) =>
      model ? (
        <Text backgroundColor={active ? modelColor(model) : C.line} color={active ? C.ink : '#E2E8F0'} bold>
          {` ${prettyModel(model)} `}
        </Text>
      ) : null

    if (mode === 'tree') {
      const ordered = orderedAgents(f)
      const perAgent = ordered.length > 4 ? 5 : 10
      return (
        <Box flexDirection="column" rowGap={1}>
          {header}
          {tiles}
          {ordered.map(({ agent, depth }) => {
            const mine = f.calls.filter(c => c.agent === agent.id)
            const shown = mine.slice(-perAgent)
            const hidden = agent.calls - shown.length
            const dur =
              agent.id === MAIN
                ? ''
                : ` · ${fmtDur((agent.endedAt ?? (agent.status === 'running' ? now : lastEventAt(f))) - agent.startedAt)}`
            return (
              <Box key={`tree-${agent.id}`} flexDirection="column" paddingLeft={depth * 2}>
                <Button key={`open-${agent.id}`} plain onPress={openTranscript(agent)}>
                  <Text bold {...(agent.status === 'running' ? { color: modelColor(agent.model) } : { dimColor: true })}>
                    {agent.status === 'running' ? '● ' : '○ '}
                    {agentName(agent)}
                  </Text>
                  <Text dimColor>
                    {`${agent.model ? ` · ${prettyModel(agent.model)}` : ''} · ${agent.status} · ${agent.calls} calls${dur}`}
                  </Text>
                </Button>
                {hidden > 0 && <Text dimColor>    … {hidden} earlier</Text>}
                {shown.map(c => (
                  <Box key={`c-${c.id}`} flexDirection="row" paddingLeft={2}>
                    <Text {...(c.status === 'running' ? { color: CATS[categoryOf(c.tool)].color } : c.status === 'error' ? { color: ERR } : { dimColor: true })}>
                      {c.status === 'running' ? '◐ ' : c.status === 'error' ? '✗ ' : '✓ '}
                      {shortTool(c.tool)}
                    </Text>
                    <Text dimColor wrap="truncate-end">
                      {c.label ? `  ${c.label}` : ''}  {fmtDur((c.endedAt ?? now) - c.startedAt)}
                    </Text>
                  </Box>
                ))}
              </Box>
            )
          })}
        </Box>
      )
    }

    // ── the map: main session on the left, what it called on the right
    const main = f.agents.find(a => a.id === MAIN) ?? MAIN_AGENT
    const mainActive = main.status === 'running'
    const mainColor = modelColor(main.model)
    const spawned = new Set(f.agents.map(a => a.spawnCallId).filter((x): x is string => x !== null))
    const mainTools = f.calls.filter(
      c => c.agent === MAIN && !isBookkeeping(c.tool) && !(isAgentTool(c.tool) && spawned.has(c.id)),
    )
    const runningMainTool = [...mainTools].reverse().find(c => c.status === 'running')
    const lastMainTool = mainTools[mainTools.length - 1]

    // Side by side only where both halves have room; a narrow pane stacks.
    const side = cols >= 80
    const mainW = side ? Math.max(30, Math.min(44, Math.round(cols * 0.36))) : cols
    // Characters a line of the main card holds before it is cut.
    const room = Math.max(12, mainW - 6)

    // A few tasks around the current one; the rest are counted, not listed.
    const anchor = Math.max(
      0,
      plan.items.findIndex(i => i.status === 'in_progress') >= 0
        ? plan.items.findIndex(i => i.status === 'in_progress')
        : plan.items.findIndex(i => i.status === 'pending'),
    )
    const firstShown = Math.max(0, Math.min(anchor - 1, plan.items.length - 4))
    const shownTasks = plan.items.slice(firstShown, firstShown + 4)
    const tasksAfter = plan.items.length - firstShown - shownTasks.length

    const ctx = stats.contextPct
    const ctxColor = ctx === null ? undefined : ctx < 60 ? OK : ctx < 85 ? WARN : ERR

    const nowText = runningMainTool
      ? `${shortTool(runningMainTool.tool)} · ${runningMainTool.label}`
      : mainActive
        ? 'Thinking…'
        : 'Waiting for your next prompt'

    const mainCard = (
      <Box
        key="main"
        flexDirection="column"
        rowGap={1}
        borderStyle="round"
        borderColor={mainActive ? mainColor : C.line}
        paddingX={1}
        {...(side ? { width: mainW } : {})}
        {...(mainActive ? wash(mainColor) : cardFill)}
      >
        <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
          <Text size="heading" weight="bold" {...(mainActive ? { color: mainColor } : { dimColor: true })}>
            {mainActive ? '● ' : '○ '}Main session
          </Text>
          {chip(main.model, mainActive)}
        </Box>
        <Box flexDirection="row" columnGap={1} flexWrap="wrap" rowGap={1}>
          {tile('m-ctx', ctx !== null ? `${ctx}%` : '—', 'context', ctxColor, 9)}
          {tile('m-turns', String(stats.turns), 'turns', undefined, 7)}
          {tile('m-calls', String(mainTools.length), 'calls', undefined, 7)}
        </Box>
        {plan.items.length > 0 && (
          <Box flexDirection="column">
            <Text size="caption" dimColor>
              {`TASKS · ${done}/${plan.items.length}`}
            </Text>
            {firstShown > 0 && (
              <Text size="caption" dimColor>
                {`  ✓ ${firstShown} done`}
              </Text>
            )}
            {shownTasks.map(t => (
              <Text
                wrap="truncate-end"
                {...(t.status === 'in_progress'
                  ? { color: WARN, bold: true }
                  : t.status === 'completed'
                    ? { dimColor: true, strikethrough: false }
                    : { dimColor: true })}
              >
                {`${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○'} ${cut(t.content, room - 2)}`}
              </Text>
            ))}
            {tasksAfter > 0 && (
              <Text size="caption" dimColor>
                {`  +${tasksAfter} more`}
              </Text>
            )}
          </Box>
        )}
        <Box flexDirection="column">
          <Text size="caption" dimColor>
            NOW
          </Text>
          <Text wrap="truncate-end" {...(mainActive ? {} : { dimColor: true })}>
            {cut(nowText, room)}
          </Text>
        </Box>
        {stats.prompt !== '' && (
          <Text size="caption" dimColor wrap="truncate-end">
            {`Prompt · ${cut(stats.prompt, room + 6)}`}
          </Text>
        )}
      </Box>
    )

    // Two arrows per node: the input going out, the output coming back.
    const arrows = (
      active: boolean,
      color: string,
      inLabel: string,
      out: 'ok' | 'err' | 'cut' | 'pending',
      outLabel: string,
    ) => (
      <Box flexDirection="column" width={9}>
        <Text mono {...(active ? { color, bold: true } : { dimColor: true })}>
          {`─${inLabel}`.padEnd(7, '─') + '▶'}
        </Text>
        <Text mono {...(out === 'ok' ? { color: OK } : out === 'err' ? { color: ERR } : { dimColor: true })}>
          {out === 'pending' ? '◀╌╌╌╌╌╌╌' : `◀${outLabel}`.padEnd(8, '─')}
        </Text>
      </Box>
    )

    // Tools the main session called itself: grouped counts, the list on a click.
    const groups = new Map<Cat, { n: number; live: number; errors: number }>()
    for (const c of mainTools) {
      const cat = categoryOf(c.tool)
      const g = groups.get(cat) ?? { n: 0, live: 0, errors: 0 }
      g.n += 1
      if (c.status === 'running') g.live += 1
      if (c.status === 'error') g.errors += 1
      groups.set(cat, g)
    }
    const toolsActive = runningMainTool !== undefined
    const toolsColor = runningMainTool ? CATS[categoryOf(runningMainTool.tool)].color : C.slate
    const listRoom = Math.max(16, (side ? cols - mainW - 14 : cols - 12) - 18)
    const toolsNode =
      mainTools.length > 0 ? (
        <Box key="tools" flexDirection="row" alignItems="center" columnGap={1}>
          {arrows(toolsActive, toolsColor, 'call', toolsActive ? 'pending' : lastMainTool?.status === 'error' ? 'err' : 'ok', 'result')}
          <Box
            flexDirection="column"
            flexGrow={1}
            borderStyle="single"
            borderColor={toolsActive ? toolsColor : C.line}
            paddingX={1}
            {...(toolsActive ? wash(toolsColor) : cardFill)}
          >
            <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
              <Box flexDirection="row" columnGap={1}>
                <Text backgroundColor={toolsActive ? C.sky : C.line} color={toolsActive ? C.ink : '#E2E8F0'} bold>
                  {' ⚙ TOOLS '}
                </Text>
                <Text bold {...(toolsActive ? { color: toolsColor } : { dimColor: true })}>
                  {toolsActive ? 'working' : 'idle'}
                </Text>
              </Box>
              <Button key="tools-toggle" plain onPress={toggleTools}>
                <Text color={C.sky}>{toolsOpen ? '▾ hide' : `▸ ${mainTools.length} calls`}</Text>
              </Button>
            </Box>
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {CAT_ORDER.filter(cat => groups.has(cat)).map(cat => {
                const g = groups.get(cat) ?? { n: 0, live: 0, errors: 0 }
                return (
                  <Text {...(g.live > 0 ? { color: CATS[cat].color, bold: true } : { color: CATS[cat].color, dimColor: true })}>
                    {`${CATS[cat].name} ${g.n}${g.errors ? ` · ${g.errors}✗` : ''}`}
                  </Text>
                )
              })}
            </Box>
            {runningMainTool && (
              <Text wrap="truncate-end" color={toolsColor}>
                {cut(`Now: ${shortTool(runningMainTool.tool)} · ${runningMainTool.label}`, listRoom + 16)}
              </Text>
            )}
            {toolsOpen &&
              [...mainTools]
                .reverse()
                .slice(0, 15)
                .map(c => (
                  <Box key={`mt-${c.id}`} flexDirection="row" justifyContent="space-between" columnGap={1}>
                    <Text
                      size="caption"
                      wrap="truncate-end"
                      {...(c.status === 'running' ? { color: CATS[categoryOf(c.tool)].color } : c.status === 'error' ? { color: ERR } : { dimColor: true })}
                    >
                      {`${c.status === 'running' ? '◐' : c.status === 'error' ? '✗' : '✓'} ${shortTool(c.tool)}  ${cut(c.label, listRoom)}`}
                    </Text>
                    <Text size="caption" dimColor>
                      {c.status === 'running' ? 'working' : fmtDur((c.endedAt ?? now) - c.startedAt)}
                    </Text>
                  </Box>
                ))}
          </Box>
        </Box>
      ) : null

    // Subagents: active ones and the latest few each get a card; older
    // finished ones are grouped by type.
    const tops = subs.filter(a => parentOf(f, a) === MAIN).sort((a, b) => a.startedAt - b.startedAt)
    const live = tops.filter(a => a.status === 'running' || a.status === 'idle')
    const finished = tops.filter(a => !(a.status === 'running' || a.status === 'idle'))
    const recent = finished.slice(-4).reverse()
    const older = finished.slice(0, Math.max(0, finished.length - 4))
    const olderByType = new Map<string, FlowAgent[]>()
    for (const a of older) olderByType.set(a.type, [...(olderByType.get(a.type) ?? []), a])

    const agentNode = (a: FlowAgent) => {
      const active = a.status === 'running'
      const failed = a.status === 'failed'
      const color = failed ? ERR : modelColor(a.model)
      const mine = f.calls.filter(c => c.agent === a.id && !isBookkeeping(c.tool))
      const now1 = [...mine].reverse().find(c => c.status === 'running')
      const last = mine[mine.length - 1]
      const kids = subs.filter(k => parentOf(f, k) === a.id)
      const doing = now1
        ? `Now: ${shortTool(now1.tool)} · ${now1.label}`
        : last
          ? `Last: ${shortTool(last.tool)} · ${last.label}`
          : active
            ? 'Starting…'
            : ''
      const tail = active ? 'working' : `${a.status} · ${fmtDur((a.endedAt ?? now) - a.startedAt)}`
      const line = [`${mine.length} call${mine.length === 1 ? '' : 's'}`, tail, doing].filter(Boolean).join(' · ')
      return (
        <Box key={`ag-${a.id}`} flexDirection="row" alignItems="center" columnGap={1}>
          {arrows(active, color, 'task', active || a.status === 'idle' ? 'pending' : failed ? 'err' : a.status === 'aborted' ? 'cut' : 'ok', 'report')}
          <Box
            flexDirection="column"
            flexGrow={1}
            borderStyle="round"
            borderColor={active ? color : failed ? ERR : C.line}
            paddingX={1}
            {...(active ? wash(color) : cardFill)}
          >
            <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
              <Button key={`open-${a.id}`} plain onPress={openTranscript(a)}>
                <Text bold {...(active ? { color } : failed ? { color: ERR } : { dimColor: true })}>
                  {active ? '◆ ' : failed ? '✗ ' : '◇ '}
                  {a.type}
                  {active ? '' : failed ? '' : ' ✓'}
                </Text>
              </Button>
              {chip(a.model, active)}
            </Box>
            {a.description !== '' && (
              <Text wrap="truncate-end" {...(active ? {} : { dimColor: true })}>
                {cut(a.description, listRoom + 16)}
              </Text>
            )}
            <Text size="caption" dimColor wrap="truncate-end">
              {cut(line, listRoom + 22)}
            </Text>
            {kids.slice(0, 3).map(k => (
              <Text
                size="caption"
                wrap="truncate-end"
                {...(k.status === 'running' ? { color: modelColor(k.model) } : { dimColor: true })}
              >
                {`↳ ${k.type}${k.model ? ` · ${prettyModel(k.model)}` : ''} · ${k.status} · ${k.calls} calls`}
              </Text>
            ))}
            {kids.length > 3 && (
              <Text size="caption" dimColor>
                {`↳ +${kids.length - 3} more`}
              </Text>
            )}
          </Box>
        </Box>
      )
    }

    const groupNode = (type: string, list: FlowAgent[]) => {
      const calls = list.reduce((n, a) => n + a.calls, 0)
      const failedN = list.filter(a => a.status === 'failed').length
      const models = [...new Set(list.map(a => prettyModel(a.model)).filter(Boolean))].join(', ')
      return (
        <Box key={`grp-${type}`} flexDirection="row" alignItems="center" columnGap={1}>
          {arrows(false, C.slate, 'task', failedN > 0 ? 'err' : 'ok', 'report')}
          <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={C.line} paddingX={1} {...cardFill}>
            <Text bold dimColor>
              {`${type} × ${list.length}`}
            </Text>
            <Text size="caption" dimColor wrap="truncate-end">
              {`${calls} calls · ${list.length - failedN} done${failedN ? ` · ${failedN} failed` : ''}${models ? ` · ${models}` : ''}`}
            </Text>
          </Box>
        </Box>
      )
    }

    const right = (
      <Box flexDirection="column" flexGrow={1} rowGap={1}>
        {mainTools.length > 0 && (
          <Text size="caption" bold color={C.sky}>
            {'⚙ TOOLS · called by the main session'}
          </Text>
        )}
        {toolsNode}
        {tops.length > 0 && (
          <Text size="caption" bold color={C.violet}>
            {`◆ SUBAGENTS · ${tops.length}${live.length ? ` · ${live.length} active` : ''}`}
          </Text>
        )}
        {live.map(agentNode)}
        {recent.map(agentNode)}
        {[...olderByType.entries()].map(([type, list]) => groupNode(type, list))}
        {mainTools.length === 0 && tops.length === 0 && (
          <Text dimColor>Tool calls and subagents will appear here, linked to the main session.</Text>
        )}
      </Box>
    )

    // ── the session log: a small table, newest first
    const rows = logRows(f, now)
    const wide = cols >= 70
    const cell = (width: number, content: JSX.Element) => (
      <Box width={width} flexShrink={0}>
        {content}
      </Box>
    )
    const logTable =
      rows.length > 0 ? (
        <Box key="log" flexDirection="column" borderStyle="round" borderColor={C.line} paddingX={1} {...cardFill}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text size="caption" bold dimColor>
              SESSION LOG
            </Text>
            <Text size="caption" dimColor>
              {`newest first · last ${rows.length}`}
            </Text>
          </Box>
          <Box flexDirection="row" columnGap={1}>
            {cell(7, <Text size="footnote" mono dimColor bold>time</Text>)}
            {wide && cell(12, <Text size="footnote" mono dimColor bold>agent</Text>)}
            {cell(13, <Text size="footnote" mono dimColor bold>event</Text>)}
            <Box flexGrow={1}>
              <Text size="footnote" mono dimColor bold>
                detail
              </Text>
            </Box>
            {cell(7, <Text size="footnote" mono dimColor bold>status</Text>)}
            {wide && cell(7, <Text size="footnote" mono dimColor bold>took</Text>)}
          </Box>
          {rows.map(r => (
            <Box key={`log-${r.key}`} flexDirection="row" columnGap={1}>
              {cell(7, <Text size="footnote" mono dimColor>{fmtStamp(r.at - f.startedAt)}</Text>)}
              {wide && cell(12, <Text size="footnote" mono dimColor wrap="truncate-end">{cut(r.who, 12)}</Text>)}
              {cell(13, <Text size="footnote" mono color={r.whatColor} wrap="truncate-end">{cut(r.what, 13)}</Text>)}
              <Box flexGrow={1}>
                <Text size="footnote" mono dimColor wrap="truncate-end">
                  {cut(r.detail, Math.max(8, cols - (wide ? 56 : 34)))}
                </Text>
              </Box>
              {cell(7, <Text size="footnote" mono color={r.statusColor}>{cut(r.status, 7)}</Text>)}
              {wide && cell(7, <Text size="footnote" mono dimColor>{r.dur}</Text>)}
            </Box>
          ))}
        </Box>
      ) : null

    return (
      <Box flexDirection="column" rowGap={1}>
        {header}
        {tiles}
        {planBlock}
        {tokenBlock}
        <Box flexDirection={side ? 'row' : 'column'} columnGap={1} rowGap={1} alignItems="flex-start">
          {mainCard}
          {right}
        </Box>
        {logTable}
      </Box>
    )
  })
}
