import { NextResponse } from 'next/server'
import fs from 'fs'
import {
  loadSessions, saveSessions, active,
  loadCredentials, decryptKey, getSessionMessages,
  loadAgents, loadSkills,
} from '@/lib/server/storage'
import { getProvider } from '@/lib/providers'
import { log } from '@/lib/server/logger'
import { streamAgentChat } from '@/lib/server/stream-agent-chat'
import type { MessageToolEvent } from '@/types'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { message, imagePath, imageUrl, internal } = await req.json()
  const isInternal = internal === true

  log.info('chat', `POST /sessions/${id}/chat`, { message: message?.slice(0, 100), imagePath, imageUrl, internal: isInternal })

  const sessions = loadSessions()
  const session = sessions[id]
  if (!session) {
    log.error('chat', `Session not found: ${id}`)
    return new NextResponse(null, { status: 404 })
  }

  if (active.has(id)) {
    log.warn('chat', `Session busy: ${id}`)
    return NextResponse.json({ error: 'Session is busy' }, { status: 409 })
  }

  // Sync session config from current agent (agent may have been updated since session creation)
  if (session.agentId) {
    const agents = loadAgents()
    const agent = agents[session.agentId]
    if (agent) {
      let changed = false
      if (agent.provider && agent.provider !== session.provider) { session.provider = agent.provider; changed = true }
      if (agent.model !== undefined && agent.model !== session.model) { session.model = agent.model; changed = true }
      if (agent.credentialId !== undefined && agent.credentialId !== session.credentialId) { session.credentialId = agent.credentialId ?? null; changed = true }
      if (agent.apiEndpoint !== undefined && agent.apiEndpoint !== session.apiEndpoint) { session.apiEndpoint = agent.apiEndpoint ?? null; changed = true }
      if (agent.tools && JSON.stringify(agent.tools) !== JSON.stringify(session.tools)) { session.tools = agent.tools; changed = true }
      if (changed) {
        log.info('chat', `Synced session ${id} config from agent ${agent.name}`, { provider: session.provider, model: session.model })
        saveSessions(sessions)
      }
    }
  }

  const providerType = session.provider || 'claude-cli'
  const provider = getProvider(providerType)
  if (!provider) {
    log.error('chat', `Unknown provider: ${providerType}`)
    return NextResponse.json({ error: `Unknown provider: ${providerType}` }, { status: 400 })
  }

  log.info('chat', `Session config`, {
    provider: providerType,
    model: session.model,
    cwd: session.cwd,
    agentId: session.agentId,
    tools: session.tools,
    hasClaudeSessionId: !!session.claudeSessionId,
  })

  // Claude CLI requires a valid cwd
  if (providerType === 'claude-cli' && !fs.existsSync(session.cwd)) {
    log.error('chat', `Directory not found: ${session.cwd}`)
    return NextResponse.json({ error: `Directory not found: ${session.cwd}` }, { status: 400 })
  }

  // Resolve API key for providers that need one
  let apiKey: string | null = null
  if (provider.requiresApiKey) {
    if (!session.credentialId) {
      log.error('chat', 'No API key configured')
      return NextResponse.json({ error: 'No API key configured for this session' }, { status: 400 })
    }
    const creds = loadCredentials()
    const cred = creds[session.credentialId]
    if (!cred) {
      log.error('chat', 'API key not found in credentials')
      return NextResponse.json({ error: 'API key not found. Please add one in Settings.' }, { status: 400 })
    }
    try {
      apiKey = decryptKey(cred.encryptedKey)
    } catch {
      log.error('chat', 'Failed to decrypt API key')
      return NextResponse.json({ error: 'Failed to decrypt API key' }, { status: 500 })
    }
  } else if (provider.optionalApiKey && session.credentialId) {
    const creds = loadCredentials()
    const cred = creds[session.credentialId]
    if (cred) {
      try {
        apiKey = decryptKey(cred.encryptedKey)
      } catch {
        log.warn('chat', 'Failed to decrypt optional API key, continuing without it')
      }
    }
  }

  if (!isInternal) {
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

  // Resolve agent system prompt if this session has an agent
  // Injection order: [userPrompt] \n\n [soul] \n\n [systemPrompt]
  let systemPrompt: string | undefined
  if (session.agentId) {
    const agents = loadAgents()
    const agent = agents[session.agentId]
    if (agent?.systemPrompt || agent?.soul) {
      const parts: string[] = []
      // Load global user preferences
      const { loadSettings: ls } = await import('@/lib/server/storage')
      const settings = ls()
      if (settings.userPrompt) parts.push(settings.userPrompt)
      if (agent.soul) parts.push(agent.soul)
      if (agent.systemPrompt) parts.push(agent.systemPrompt)
      // Inject dynamic skills
      if (agent.skillIds?.length) {
        const allSkills = loadSkills()
        for (const skillId of agent.skillIds) {
          const skill = allSkills[skillId]
          if (skill?.content) parts.push(`## Skill: ${skill.name}\n${skill.content}`)
        }
      }
      systemPrompt = parts.join('\n\n')
      log.info('chat', `Loaded agent prompt (${systemPrompt!.length} chars) for ${agent.name}`, { hasSoul: !!agent.soul, hasUserPrompt: !!settings.userPrompt })
    } else {
      log.warn('chat', `Agent ${session.agentId} found but no systemPrompt`)
    }
  }

  log.info('chat', `Starting stream for ${id} (${providerType})`, { messageLen: message.length, hasSystemPrompt: !!systemPrompt })

  // SSE streaming via ReadableStream
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const rawWrite = (data: string) => {
        controller.enqueue(encoder.encode(data))
      }

      // Collect tool events for persistence
      const collectedToolEvents: MessageToolEvent[] = []
      const write = (data: string) => {
        rawWrite(data)
        if (data.startsWith('data: ')) {
          try {
            const ev = JSON.parse(data.slice(6).trim())
            if (ev.t === 'tool_call') {
              collectedToolEvents.push({ name: ev.toolName || 'unknown', input: ev.toolInput || '' })
            } else if (ev.t === 'tool_result') {
              const last = [...collectedToolEvents].reverse().find(e => e.name === (ev.toolName || 'unknown') && !e.output)
              if (last) {
                last.output = ev.toolOutput
                const out = (ev.toolOutput || '').trim()
                if (/^(Error:|error:)/i.test(out) || out.includes('ECONNREFUSED') || out.includes('ETIMEDOUT') || out.includes('Error:')) {
                  last.error = true
                }
              }
            }
          } catch { /* not JSON, ignore */ }
        }
      }

      // Track this session as active with an abort controller for cancellation
      const abortController = new AbortController()
      active.set(id, { kill: () => abortController.abort() })

      try {
        const cliProviders = ['claude-cli', 'codex-cli', 'opencode-cli']
        const hasTools = session.tools?.length && !cliProviders.includes(session.provider)

        const fullResponse = hasTools
          ? await streamAgentChat({
              session,
              message,
              imagePath,
              apiKey,
              systemPrompt,
              write,
              history: getSessionMessages(id),
            })
          : await provider.handler.streamChat({
              session,
              message,
              imagePath,
              apiKey,
              systemPrompt,
              write,
              active,
              loadHistory: getSessionMessages,
            })

        log.info('chat', `Stream complete for ${id}`, { responseLen: typeof fullResponse === 'string' ? fullResponse.length : 0 })

        const trimmed = typeof fullResponse === 'string' ? fullResponse.trim() : ''
        const shouldPersistAssistant = trimmed.length > 0
          && (!isInternal || trimmed !== 'HEARTBEAT_OK')

        if (shouldPersistAssistant) {
          session.messages.push({
            role: 'assistant',
            text: trimmed,
            time: Date.now(),
            toolEvents: collectedToolEvents.length ? collectedToolEvents : undefined,
          })
          session.lastActiveAt = Date.now()
          const s = loadSessions()
          s[id] = session
          saveSessions(s)
        } else if (trimmed.length > 0) {
          log.info('chat', `Skipped persistence for internal heartbeat ACK in ${id}`)
        } else {
          log.warn('chat', `Empty response from provider for ${id}`)
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        log.error('chat', `streamChat threw for ${id}`, errMsg)
        write(`data: ${JSON.stringify({ t: 'err', text: errMsg })}\n\n`)
      } finally {
        active.delete(id)
      }

      write(`data: ${JSON.stringify({ t: 'done' })}\n\n`)
      controller.close()
    },
  })

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
