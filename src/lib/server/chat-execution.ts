import fs from 'fs'
import {
  loadSessions,
  saveSessions,
  loadCredentials,
  decryptKey,
  getSessionMessages,
  loadAgents,
  loadSkills,
  loadSettings,
  active,
} from './storage'
import { getProvider } from '@/lib/providers'
import { log } from './logger'
import { streamAgentChat } from './stream-agent-chat'
import type { MessageToolEvent, SSEEvent } from '@/types'

const CLI_PROVIDER_IDS = new Set(['claude-cli', 'codex-cli', 'opencode-cli'])

export interface ExecuteChatTurnInput {
  sessionId: string
  message: string
  imagePath?: string
  imageUrl?: string
  internal?: boolean
  source?: string
  runId?: string
  signal?: AbortSignal
  onEvent?: (event: SSEEvent) => void
}

export interface ExecuteChatTurnResult {
  runId?: string
  sessionId: string
  text: string
  persisted: boolean
  toolEvents: MessageToolEvent[]
  error?: string
}

function extractEventJson(line: string): SSEEvent | null {
  if (!line.startsWith('data: ')) return null
  try {
    return JSON.parse(line.slice(6).trim()) as SSEEvent
  } catch {
    return null
  }
}

function collectToolEvent(ev: SSEEvent, bag: MessageToolEvent[]) {
  if (ev.t === 'tool_call') {
    bag.push({
      name: ev.toolName || 'unknown',
      input: ev.toolInput || '',
    })
    return
  }
  if (ev.t === 'tool_result') {
    const idx = bag.findLastIndex((e) => e.name === (ev.toolName || 'unknown') && !e.output)
    if (idx === -1) return
    const output = ev.toolOutput || ''
    const isError = /^(Error:|error:)/i.test(output.trim())
      || output.includes('ECONNREFUSED')
      || output.includes('ETIMEDOUT')
      || output.includes('Error:')
    bag[idx] = {
      ...bag[idx],
      output,
      error: isError || undefined,
    }
  }
}

function syncSessionFromAgent(sessionId: string): void {
  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session?.agentId) return
  const agents = loadAgents()
  const agent = agents[session.agentId]
  if (!agent) return

  let changed = false
  if (agent.provider && agent.provider !== session.provider) { session.provider = agent.provider; changed = true }
  if (agent.model !== undefined && agent.model !== session.model) { session.model = agent.model; changed = true }
  if (agent.credentialId !== undefined && agent.credentialId !== session.credentialId) { session.credentialId = agent.credentialId ?? null; changed = true }
  if (agent.apiEndpoint !== undefined && agent.apiEndpoint !== session.apiEndpoint) { session.apiEndpoint = agent.apiEndpoint ?? null; changed = true }
  if (agent.tools && JSON.stringify(agent.tools) !== JSON.stringify(session.tools)) { session.tools = agent.tools; changed = true }

  if (changed) {
    sessions[sessionId] = session
    saveSessions(sessions)
  }
}

function buildAgentSystemPrompt(session: any): string | undefined {
  if (!session.agentId) return undefined
  const agents = loadAgents()
  const agent = agents[session.agentId]
  if (!agent?.systemPrompt && !agent?.soul) return undefined

  const settings = loadSettings()
  const parts: string[] = []
  if (settings.userPrompt) parts.push(settings.userPrompt)
  if (agent.soul) parts.push(agent.soul)
  if (agent.systemPrompt) parts.push(agent.systemPrompt)
  if (agent.skillIds?.length) {
    const allSkills = loadSkills()
    for (const skillId of agent.skillIds) {
      const skill = allSkills[skillId]
      if (skill?.content) parts.push(`## Skill: ${skill.name}\n${skill.content}`)
    }
  }
  return parts.join('\n\n')
}

function resolveApiKeyForSession(session: any, provider: any): string | null {
  if (provider.requiresApiKey) {
    if (!session.credentialId) throw new Error('No API key configured for this session')
    const creds = loadCredentials()
    const cred = creds[session.credentialId]
    if (!cred) throw new Error('API key not found. Please add one in Settings.')
    return decryptKey(cred.encryptedKey)
  }
  if (provider.optionalApiKey && session.credentialId) {
    const creds = loadCredentials()
    const cred = creds[session.credentialId]
    if (cred) {
      try { return decryptKey(cred.encryptedKey) } catch { return null }
    }
  }
  return null
}

export async function executeSessionChatTurn(input: ExecuteChatTurnInput): Promise<ExecuteChatTurnResult> {
  const {
    sessionId,
    message,
    imagePath,
    imageUrl,
    internal = false,
    runId,
    source = 'chat',
    onEvent,
    signal,
  } = input

  syncSessionFromAgent(sessionId)

  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session) throw new Error(`Session not found: ${sessionId}`)

  const providerType = session.provider || 'claude-cli'
  const provider = getProvider(providerType)
  if (!provider) throw new Error(`Unknown provider: ${providerType}`)

  if (providerType === 'claude-cli' && !fs.existsSync(session.cwd)) {
    throw new Error(`Directory not found: ${session.cwd}`)
  }

  const apiKey = resolveApiKeyForSession(session, provider)

  if (!internal) {
    session.messages.push({
      role: 'user',
      text: message,
      time: Date.now(),
      imagePath: imagePath || undefined,
      imageUrl: imageUrl || undefined,
    })
    session.lastActiveAt = Date.now()
    saveSessions(sessions)
  }

  const systemPrompt = buildAgentSystemPrompt(session)
  const toolEvents: MessageToolEvent[] = []

  const emit = (ev: SSEEvent) => {
    collectToolEvent(ev, toolEvents)
    onEvent?.(ev)
  }

  const parseAndEmit = (raw: string) => {
    const lines = raw.split('\n').filter(Boolean)
    for (const line of lines) {
      const ev = extractEventJson(line)
      if (ev) emit(ev)
    }
  }

  let fullResponse = ''
  let errorMessage: string | undefined

  const abortController = new AbortController()
  const abortFromOutside = () => abortController.abort()
  if (signal) {
    if (signal.aborted) abortController.abort()
    else signal.addEventListener('abort', abortFromOutside)
  }

  active.set(sessionId, {
    runId: runId || null,
    source,
    kill: () => abortController.abort(),
  })

  try {
    const hasTools = !!session.tools?.length && !CLI_PROVIDER_IDS.has(providerType)
    fullResponse = hasTools
      ? await streamAgentChat({
          session,
          message,
          imagePath,
          apiKey,
          systemPrompt,
          write: (raw) => parseAndEmit(raw),
          history: getSessionMessages(sessionId),
          signal: abortController.signal,
        })
      : await provider.handler.streamChat({
          session,
          message,
          imagePath,
          apiKey,
          systemPrompt,
          write: (raw: string) => parseAndEmit(raw),
          active,
          loadHistory: getSessionMessages,
        })
  } catch (err: any) {
    errorMessage = err?.message || String(err)
    emit({ t: 'err', text: errorMessage })
    log.error('chat-run', `Run failed for session ${sessionId}`, {
      runId,
      source,
      internal,
      error: errorMessage,
    })
  } finally {
    active.delete(sessionId)
    if (signal) signal.removeEventListener('abort', abortFromOutside)
  }

  const trimmed = (fullResponse || '').trim()
  const shouldPersistAssistant = trimmed.length > 0
    && (!internal || trimmed !== 'HEARTBEAT_OK')

  if (shouldPersistAssistant) {
    const fresh = loadSessions()
    const current = fresh[sessionId]
    if (current) {
      current.messages.push({
        role: 'assistant',
        text: trimmed,
        time: Date.now(),
        toolEvents: toolEvents.length ? toolEvents : undefined,
        kind: internal ? 'heartbeat' : 'chat',
      })
      current.lastActiveAt = Date.now()
      fresh[sessionId] = current
      saveSessions(fresh)
    }
  }

  return {
    runId,
    sessionId,
    text: trimmed,
    persisted: shouldPersistAssistant,
    toolEvents,
    error: errorMessage,
  }
}
