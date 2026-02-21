import crypto from 'crypto'
import type { MessageToolEvent } from '@/types'
import { loadSessions, saveSessions } from './storage'
import { log } from './logger'

const MAIN_SESSION_NAME = '__main__'
const MAX_PENDING_EVENTS = 40
const EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_FOLLOWUP_DELAY_SEC = 45
const MAX_FOLLOWUP_CHAIN = 6
const META_LINE_RE = /\[MAIN_LOOP_META\]\s*(\{[^\n]*\})/i

export interface MainLoopEvent {
  id: string
  type: string
  text: string
  createdAt: number
}

export interface MainLoopState {
  goal: string | null
  status: 'idle' | 'progress' | 'blocked' | 'ok'
  summary: string | null
  nextAction: string | null
  paused: boolean
  autonomyMode: 'assist' | 'autonomous'
  pendingEvents: MainLoopEvent[]
  followupChainCount: number
  metaMissCount: number
  lastTickAt: number | null
  updatedAt: number
}

interface MainLoopMeta {
  status?: 'idle' | 'progress' | 'blocked' | 'ok'
  summary?: string
  next_action?: string
  follow_up?: boolean
  delay_sec?: number
  goal?: string
  consume_event_ids?: string[]
}

export interface MainLoopFollowupRequest {
  message: string
  delayMs: number
  dedupeKey: string
}

export interface PushMainLoopEventInput {
  type: string
  text: string
  user?: string | null
}

export interface HandleMainLoopRunResultInput {
  sessionId: string
  message: string
  internal: boolean
  source: string
  resultText: string
  error?: string
  toolEvents?: MessageToolEvent[]
}

function toOneLine(value: string, max = 240): string {
  return (value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function pruneEvents(events: MainLoopEvent[], now = Date.now()): MainLoopEvent[] {
  const minTs = now - EVENT_TTL_MS
  const fresh = events.filter((e) => e && typeof e.createdAt === 'number' && e.createdAt >= minTs)
  if (fresh.length <= MAX_PENDING_EVENTS) return fresh
  return fresh.slice(fresh.length - MAX_PENDING_EVENTS)
}

function normalizeState(raw: any, now = Date.now()): MainLoopState {
  const status = raw?.status === 'blocked' || raw?.status === 'ok' || raw?.status === 'progress' || raw?.status === 'idle'
    ? raw.status
    : 'idle'

  const pendingRaw = Array.isArray(raw?.pendingEvents) ? raw.pendingEvents : []
  const pendingEvents = pruneEvents(
    pendingRaw
      .map((e: any) => {
        const text = toOneLine(typeof e?.text === 'string' ? e.text : '')
        if (!text) return null
        return {
          id: typeof e?.id === 'string' && e.id.trim() ? e.id.trim() : `evt_${crypto.randomBytes(3).toString('hex')}`,
          type: typeof e?.type === 'string' && e.type.trim() ? e.type.trim() : 'event',
          text,
          createdAt: typeof e?.createdAt === 'number' ? e.createdAt : now,
        } as MainLoopEvent
      })
      .filter(Boolean) as MainLoopEvent[],
    now,
  )

  return {
    goal: typeof raw?.goal === 'string' && raw.goal.trim() ? raw.goal.trim().slice(0, 600) : null,
    status,
    summary: typeof raw?.summary === 'string' && raw.summary.trim() ? raw.summary.trim().slice(0, 800) : null,
    nextAction: typeof raw?.nextAction === 'string' && raw.nextAction.trim() ? raw.nextAction.trim().slice(0, 600) : null,
    paused: raw?.paused === true,
    autonomyMode: raw?.autonomyMode === 'assist' ? 'assist' : 'autonomous',
    pendingEvents,
    followupChainCount: clampInt(raw?.followupChainCount, 0, 0, 100),
    metaMissCount: clampInt(raw?.metaMissCount, 0, 0, 100),
    lastTickAt: typeof raw?.lastTickAt === 'number' ? raw.lastTickAt : null,
    updatedAt: typeof raw?.updatedAt === 'number' ? raw.updatedAt : now,
  }
}

function appendEvent(state: MainLoopState, type: string, text: string, now = Date.now()): boolean {
  const normalizedText = toOneLine(text)
  if (!normalizedText) return false
  const recent = state.pendingEvents.at(-1)
  if (recent && recent.type === type && recent.text === normalizedText && now - recent.createdAt < 60_000) {
    return false
  }
  state.pendingEvents.push({
    id: `evt_${crypto.randomBytes(4).toString('hex')}`,
    type,
    text: normalizedText,
    createdAt: now,
  })
  state.pendingEvents = pruneEvents(state.pendingEvents, now)
  return true
}

function inferGoalFromUserMessage(message: string): string | null {
  const text = (message || '').trim()
  if (!text) return null
  if (/^SWARM_MAIN_(MISSION_TICK|AUTO_FOLLOWUP)\b/i.test(text)) return null
  if (/^SWARM_HEARTBEAT_CHECK\b/i.test(text)) return null
  if (/^(ok|okay|cool|thanks|thx|got it|nice|yep|yeah|nope|nah)[.! ]*$/i.test(text)) return null
  return text.slice(0, 600)
}

function inferGoalFromSessionMessages(session: any): string | null {
  const msgs = Array.isArray(session?.messages) ? session.messages : []
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const msg = msgs[i]
    if (msg?.role !== 'user') continue
    const inferred = inferGoalFromUserMessage(typeof msg?.text === 'string' ? msg.text : '')
    if (inferred) return inferred
  }
  return null
}

function parseMainLoopMeta(text: string): MainLoopMeta | null {
  const raw = (text || '').trim()
  if (!raw) return null

  const markerMatch = raw.match(META_LINE_RE)
  const parseCandidate = markerMatch?.[1]
  if (parseCandidate) {
    try {
      const parsed = JSON.parse(parseCandidate)
      return normalizeMeta(parsed)
    } catch {
      // fall through
    }
  }

  // Fallback: parse any one-line JSON that appears to be the meta payload.
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue
    if (!trimmed.includes('follow_up') && !trimmed.includes('next_action') && !trimmed.includes('consume_event_ids')) continue
    try {
      const parsed = JSON.parse(trimmed)
      return normalizeMeta(parsed)
    } catch {
      // skip malformed candidate lines
    }
  }

  return null
}

function normalizeMeta(raw: any): MainLoopMeta {
  const status = raw?.status === 'blocked' || raw?.status === 'ok' || raw?.status === 'progress' || raw?.status === 'idle'
    ? raw.status
    : undefined

  const consumeIds = Array.isArray(raw?.consume_event_ids)
    ? raw.consume_event_ids
      .map((v: unknown) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
    : undefined

  const followUp = typeof raw?.follow_up === 'boolean'
    ? raw.follow_up
    : typeof raw?.follow_up === 'string'
      ? raw.follow_up.trim().toLowerCase() === 'true'
      : undefined

  return {
    status,
    summary: typeof raw?.summary === 'string' ? raw.summary.trim().slice(0, 800) : undefined,
    next_action: typeof raw?.next_action === 'string' ? raw.next_action.trim().slice(0, 600) : undefined,
    follow_up: followUp,
    delay_sec: clampInt(raw?.delay_sec, DEFAULT_FOLLOWUP_DELAY_SEC, 5, 900),
    goal: typeof raw?.goal === 'string' ? raw.goal.trim().slice(0, 600) : undefined,
    consume_event_ids: consumeIds,
  }
}

function consumeEvents(state: MainLoopState, ids: string[] | undefined) {
  if (!ids?.length) return
  const remove = new Set(ids)
  state.pendingEvents = state.pendingEvents.filter((event) => !remove.has(event.id))
}

function buildPendingEventLines(state: MainLoopState): string {
  if (!state.pendingEvents.length) return 'Pending events:\n- none'
  const lines = state.pendingEvents
    .slice(-10)
    .map((event) => `- ${event.id} | ${event.type} | ${event.text}`)
    .join('\n')
  return `Pending events (oldest → newest):\n${lines}`
}

function buildFollowupPrompt(state: MainLoopState, opts?: { hasMemoryTool?: boolean }): string {
  const hasMemoryTool = opts?.hasMemoryTool === true
  const goal = state.goal || 'No explicit goal yet. Continue with the strongest actionable objective from recent context.'
  const nextAction = state.nextAction || 'Determine the next highest-impact action and execute it.'
  return [
    'SWARM_MAIN_AUTO_FOLLOWUP',
    `Mission goal: ${goal}`,
    `Next action to execute now: ${nextAction}`,
    `Current status: ${state.status}`,
    buildPendingEventLines(state),
    'Act autonomously. Use available tools to execute work, verify results, and keep momentum.',
    state.autonomyMode === 'assist'
      ? 'Assist mode: execute safe internal analysis by default, and ask before irreversible external side effects (sending messages, purchases, account mutations).'
      : 'Autonomous mode: execute safe next actions without waiting for confirmation; ask only when blocked by permissions, credentials, or policy.',
    'Do not ask clarifying questions unless blocked by missing credentials, permissions, or safety constraints.',
    hasMemoryTool
      ? 'Use memory_tool actively: recall relevant prior notes before acting, and store a concise note after each meaningful step.'
      : 'memory_tool is unavailable in this session. Keep concise progress summaries in your status/meta output.',
    'If you are blocked by missing credentials, permissions, or policy limits, say exactly what is blocked and the smallest unblock needed.',
    'If no meaningful action remains right now, reply exactly HEARTBEAT_OK.',
    'Otherwise include a concise human update, then append exactly one line:',
    '[MAIN_LOOP_META] {"status":"progress|ok|blocked|idle","summary":"...","next_action":"...","follow_up":true|false,"delay_sec":45,"goal":"optional","consume_event_ids":["evt_..."]}',
  ].join('\n')
}

export function isMainSession(session: any): boolean {
  return session?.name === MAIN_SESSION_NAME
}

export function buildMainLoopHeartbeatPrompt(session: any, fallbackPrompt: string): string {
  const now = Date.now()
  const state = normalizeState(session?.mainLoopState, now)
  const goal = state.goal || inferGoalFromSessionMessages(session) || null
  const hasMemoryTool = Array.isArray(session?.tools) && session.tools.includes('memory')

  const promptGoal = goal || 'No explicit mission captured yet. Infer the mission from recent user instructions and continue proactively.'
  const promptSummary = state.summary || 'No prior mission summary yet.'
  const promptNextAction = state.nextAction || 'No queued action. Determine one.'

  return [
    'SWARM_MAIN_MISSION_TICK',
    `Time: ${new Date(now).toISOString()}`,
    `Mission goal: ${promptGoal}`,
    `Current status: ${state.status}`,
    `Mission paused: ${state.paused ? 'yes' : 'no'}`,
    `Autonomy mode: ${state.autonomyMode}`,
    `Last summary: ${toOneLine(promptSummary, 500)}`,
    `Last next action: ${toOneLine(promptNextAction, 500)}`,
    buildPendingEventLines(state),
    'You are running the main autonomous mission loop. Continue executing toward the goal with initiative.',
    state.autonomyMode === 'assist'
      ? 'Assist mode is active: execute safe internal work and ask before irreversible external side effects.'
      : 'Autonomous mode is active: execute safe next actions without waiting for confirmation; only ask when blocked.',
    'Use tools where needed, verify outcomes, and avoid vague status-only replies.',
    'Do not ask broad exploratory questions when a safe next action exists. Pick a reasonable assumption, execute, and adapt from evidence.',
    'Do not ask clarifying questions unless blocked by missing credentials, permissions, or safety constraints.',
    hasMemoryTool
      ? 'Use memory_tool actively: recall relevant prior notes before acting, and store concise notes about progress, constraints, and next step after each meaningful action.'
      : 'If memory_tool is unavailable, keep concise state in summary/next_action and continue execution.',
    'If nothing important changed and no action is needed now, reply exactly HEARTBEAT_OK.',
    'Otherwise: provide a concise human-readable update, then append exactly one line:',
    '[MAIN_LOOP_META] {"status":"progress|ok|blocked|idle","summary":"...","next_action":"...","follow_up":true|false,"delay_sec":45,"goal":"optional","consume_event_ids":["evt_..."]}',
    'The [MAIN_LOOP_META] JSON must be valid, on one line, and only appear once.',
    `Fallback prompt context: ${fallbackPrompt || 'SWARM_HEARTBEAT_CHECK'}`,
  ].join('\n')
}

export function stripMainLoopMetaForPersistence(text: string, internal: boolean): string {
  if (!internal) return text
  if (!text) return ''
  return text
    .split('\n')
    .filter((line) => !line.includes('[MAIN_LOOP_META]'))
    .join('\n')
    .trim()
}

export function getMainLoopStateForSession(sessionId: string): MainLoopState | null {
  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session || !isMainSession(session)) return null
  return normalizeState(session.mainLoopState)
}

export function setMainLoopStateForSession(sessionId: string, patch: Partial<MainLoopState>): MainLoopState | null {
  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session || !isMainSession(session)) return null
  const now = Date.now()
  const state = normalizeState(session.mainLoopState, now)

  if (typeof patch.goal === 'string') state.goal = patch.goal.trim().slice(0, 600) || null
  if (patch.goal === null) state.goal = null
  if (patch.status === 'idle' || patch.status === 'progress' || patch.status === 'blocked' || patch.status === 'ok') state.status = patch.status
  if (typeof patch.summary === 'string') state.summary = patch.summary.trim().slice(0, 800) || null
  if (patch.summary === null) state.summary = null
  if (typeof patch.nextAction === 'string') state.nextAction = patch.nextAction.trim().slice(0, 600) || null
  if (patch.nextAction === null) state.nextAction = null
  if (typeof patch.paused === 'boolean') state.paused = patch.paused
  if (patch.autonomyMode === 'assist' || patch.autonomyMode === 'autonomous') state.autonomyMode = patch.autonomyMode
  if (Array.isArray(patch.pendingEvents)) state.pendingEvents = pruneEvents(patch.pendingEvents, now)
  if (typeof patch.followupChainCount === 'number') state.followupChainCount = clampInt(patch.followupChainCount, state.followupChainCount, 0, 100)
  if (typeof patch.metaMissCount === 'number') state.metaMissCount = clampInt(patch.metaMissCount, state.metaMissCount, 0, 100)

  state.updatedAt = now
  session.mainLoopState = state
  sessions[sessionId] = session
  saveSessions(sessions)
  return state
}

export function pushMainLoopEventToMainSessions(input: PushMainLoopEventInput): number {
  const text = toOneLine(input.text)
  if (!text) return 0

  const sessions = loadSessions()
  const now = Date.now()
  let changed = 0

  for (const session of Object.values(sessions) as any[]) {
    if (!isMainSession(session)) continue
    if (input.user && session.user && session.user !== input.user) continue

    const state = normalizeState(session.mainLoopState, now)
    const appended = appendEvent(state, input.type || 'event', text, now)
    if (!appended) continue
    state.updatedAt = now
    session.mainLoopState = state
    changed += 1
  }

  if (changed > 0) {
    saveSessions(sessions)
    log.info('main-loop', `Queued event for ${changed} main session(s)`, {
      type: input.type,
      text,
      user: input.user || null,
    })
  }

  return changed
}

export function handleMainLoopRunResult(input: HandleMainLoopRunResultInput): MainLoopFollowupRequest | null {
  const sessions = loadSessions()
  const session = sessions[input.sessionId]
  if (!session || !isMainSession(session)) return null

  const now = Date.now()
  const state = normalizeState(session.mainLoopState, now)
  const hasMemoryTool = Array.isArray(session.tools) && session.tools.includes('memory')
  state.pendingEvents = pruneEvents(state.pendingEvents, now)

  const userGoal = inferGoalFromUserMessage(input.message)
  if (!input.internal) {
    if (userGoal) {
      state.goal = userGoal
      state.status = 'progress'
      appendEvent(state, 'user_instruction', `User goal updated: ${userGoal}`, now)
    }
    state.followupChainCount = 0
  }

  if (state.paused && input.internal) {
    state.updatedAt = now
    session.mainLoopState = state
    sessions[input.sessionId] = session
    saveSessions(sessions)
    return null
  }

  if (input.error) {
    appendEvent(state, 'run_error', `Run error (${input.source}): ${toOneLine(input.error, 400)}`, now)
    state.status = 'blocked'
  }

  for (const event of input.toolEvents || []) {
    if (!event?.error) continue
    appendEvent(
      state,
      'tool_error',
      `Tool ${event.name || 'unknown'} error: ${toOneLine(event.output || event.input || 'unknown error', 400)}`,
      now,
    )
  }

  let followup: MainLoopFollowupRequest | null = null
  const shouldAutoKickFromUserGoal = !input.internal
    && !input.error
    && !!userGoal
    && !state.paused
    && state.autonomyMode === 'autonomous'

  if (shouldAutoKickFromUserGoal) {
    followup = {
      message: buildFollowupPrompt(state, { hasMemoryTool }),
      delayMs: 1500,
      dedupeKey: `main-loop-user-kickoff:${input.sessionId}`,
    }
  }

  if (input.internal) {
    state.lastTickAt = now
    const trimmedText = (input.resultText || '').trim()
    const isHeartbeatOk = /^HEARTBEAT_OK$/i.test(trimmedText)
    const meta = parseMainLoopMeta(trimmedText)

    if (meta) {
      state.metaMissCount = 0
      if (meta.goal) state.goal = meta.goal
      if (meta.status) state.status = meta.status
      if (meta.summary) state.summary = meta.summary
      if (meta.next_action) state.nextAction = meta.next_action
      consumeEvents(state, meta.consume_event_ids)

      if (meta.follow_up === true && !input.error && !isHeartbeatOk && !state.paused && state.followupChainCount < MAX_FOLLOWUP_CHAIN) {
        state.followupChainCount += 1
        const delaySec = clampInt(meta.delay_sec, DEFAULT_FOLLOWUP_DELAY_SEC, 5, 900)
        followup = {
          message: buildFollowupPrompt(state, { hasMemoryTool }),
          delayMs: delaySec * 1000,
          dedupeKey: `main-loop-followup:${input.sessionId}`,
        }
      } else if (meta.follow_up === false || isHeartbeatOk) {
        state.followupChainCount = 0
      }
    } else if (!isHeartbeatOk && trimmedText) {
      state.metaMissCount = Math.min(100, state.metaMissCount + 1)
      state.summary = toOneLine(trimmedText, 700)
      if (state.status === 'idle') state.status = 'progress'
      appendEvent(state, 'meta_missing', 'Main-loop reply missing [MAIN_LOOP_META] contract; state inferred from text.', now)
    } else if (isHeartbeatOk) {
      state.metaMissCount = 0
    }
  }

  state.updatedAt = now
  session.mainLoopState = state
  sessions[input.sessionId] = session
  saveSessions(sessions)

  return followup
}
