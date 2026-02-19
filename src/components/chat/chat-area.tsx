'use client'

import { useEffect, useCallback, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { fetchMessages, clearMessages, deleteSession, devServer, stopSession, checkBrowser, stopBrowser } from '@/lib/sessions'
import { useMediaQuery } from '@/hooks/use-media-query'
import { ChatHeader } from './chat-header'
import { DevServerBar } from './dev-server-bar'
import { MessageList } from './message-list'
import { SessionDebugPanel } from './session-debug-panel'
import { ChatInput } from '@/components/input/chat-input'
import { Dropdown, DropdownItem, DropdownSep } from '@/components/shared/dropdown'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'

const PROMPT_SUGGESTIONS = [
  { text: 'List all my sessions and agents', icon: 'book', gradient: 'from-[#6366F1]/10 to-[#818CF8]/5' },
  { text: 'Help me set up a new connector', icon: 'link', gradient: 'from-[#EC4899]/10 to-[#F472B6]/5' },
  { text: 'Create a new agent for me', icon: 'bot', gradient: 'from-[#34D399]/10 to-[#6EE7B7]/5' },
  { text: 'Schedule a recurring task', icon: 'check', gradient: 'from-[#F59E0B]/10 to-[#FBBF24]/5' },
]

export function ChatArea() {
  const session = useAppStore((s) => {
    const id = s.currentSessionId
    return id ? s.sessions[id] : null
  })
  const sessionId = useAppStore((s) => s.currentSessionId)
  const currentUser = useAppStore((s) => s.currentUser)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const removeSessionFromStore = useAppStore((s) => s.removeSession)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const appSettings = useAppStore((s) => s.appSettings)
  const { messages, setMessages, streaming, sendMessage, sendHeartbeat, stopStreaming, devServer: devServerStatus, setDevServer, debugOpen, setDebugOpen } = useChatStore()
  const isDesktop = useMediaQuery('(min-width: 768px)')

  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [browserActive, setBrowserActive] = useState(false)

  useEffect(() => {
    if (!sessionId) return
    // Clear stale state from the previous session
    setMessages([])
    useChatStore.setState({ streaming: false, streamText: '', toolEvents: [] })
    fetchMessages(sessionId).then(setMessages).catch(() => {
      setMessages(session?.messages || [])
    })
    // If server reports session is still active, show streaming state
    if (session?.active) {
      useChatStore.setState({ streaming: true, streamText: '' })
    }
    devServer(sessionId, 'status').then((r) => {
      setDevServer(r.running ? r : null)
    }).catch(() => setDevServer(null))
    // Check browser status
    if (session?.tools?.includes('browser')) {
      checkBrowser(sessionId).then((r) => setBrowserActive(r.active)).catch(() => setBrowserActive(false))
    } else {
      setBrowserActive(false)
    }
  }, [sessionId])

  // Auto-poll messages for orchestrated or server-active sessions
  const isOrchestrated = session?.sessionType === 'orchestrated'
  const isServerActive = session?.active === true
  useEffect(() => {
    if (!sessionId || (!isOrchestrated && !isServerActive)) return
    const interval = setInterval(async () => {
      try {
        const msgs = await fetchMessages(sessionId)
        if (msgs.length > messages.length) {
          setMessages(msgs)
        }
        // Check if session is still active on the server
        if (isServerActive) {
          await loadSessions()
        }
      } catch {}
    }, 2000)
    return () => clearInterval(interval)
  }, [sessionId, isOrchestrated, isServerActive, messages.length])

  // When server-active flag drops, stop the streaming indicator
  useEffect(() => {
    if (!sessionId) return
    if (!isServerActive && streaming && !useChatStore.getState().streamText) {
      // Server finished but we weren't the ones streaming — clear the indicator
      fetchMessages(sessionId).then(setMessages).catch(() => {})
      useChatStore.setState({ streaming: false, streamText: '' })
    }
  }, [isServerActive, sessionId])

  // Poll browser status while session has browser tools
  const hasBrowserTool = session?.tools?.includes('browser')
  useEffect(() => {
    if (!sessionId || !hasBrowserTool) return
    const interval = setInterval(() => {
      checkBrowser(sessionId).then((r) => setBrowserActive(r.active)).catch(() => {})
    }, 5000)
    return () => clearInterval(interval)
  }, [sessionId, hasBrowserTool])

  // Heartbeat polling for ongoing sessions.
  useEffect(() => {
    if (!sessionId || !session?.tools?.length) return
    if (appSettings.loopMode !== 'ongoing') return

    const raw = appSettings.heartbeatIntervalSec
    const parsed = typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number.parseInt(raw, 10)
        : Number.NaN
    const intervalSec = Number.isFinite(parsed) ? Math.max(0, parsed) : 120
    if (intervalSec <= 0) return

    const interval = setInterval(() => {
      if (useAppStore.getState().currentSessionId !== sessionId) return
      if (useChatStore.getState().streaming) return
      sendHeartbeat(sessionId).catch(() => {})
    }, intervalSec * 1000)

    return () => clearInterval(interval)
  }, [sessionId, session?.tools?.length, appSettings.loopMode, appSettings.heartbeatIntervalSec, sendHeartbeat])

  const handleStopBrowser = useCallback(async () => {
    if (!sessionId) return
    await stopBrowser(sessionId)
    setBrowserActive(false)
  }, [sessionId])

  const handleDeploy = useCallback(() => {
    setMenuOpen(false)
    sendMessage('Please git add all changes, commit with a short descriptive message, and push to the remote. Do it now without asking.')
  }, [sendMessage])

  const handleDevServer = useCallback(async () => {
    if (!sessionId) return
    setMenuOpen(false)
    setDevServer({ running: false, url: 'Starting dev server...' })
    try {
      const r = await devServer(sessionId, 'start')
      setDevServer(r.running ? r : null)
    } catch {
      setDevServer(null)
    }
  }, [sessionId])

  const handleStopDevServer = useCallback(async () => {
    if (!sessionId) return
    await devServer(sessionId, 'stop')
    setDevServer(null)
  }, [sessionId])

  const handleClear = useCallback(async () => {
    setConfirmClear(false)
    if (!sessionId) return
    await clearMessages(sessionId)
    setMessages([])
    loadSessions()
  }, [sessionId])

  const handleDelete = useCallback(async () => {
    setConfirmDelete(false)
    if (!sessionId) return
    await deleteSession(sessionId)
    removeSessionFromStore(sessionId)
    setCurrentSession(null)
  }, [sessionId])

  const handleBack = useCallback(() => {
    setCurrentSession(null)
  }, [])

  const handlePrompt = useCallback((text: string) => {
    sendMessage(text)
  }, [sendMessage])

  if (!session) return null

  const isMainChat = session.name === '__main__'
  const isEmpty = !messages.length && !streaming

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 relative">
      {isDesktop && (
        <ChatHeader
          session={session}
          streaming={streaming}
          onStop={stopStreaming}
          onMenuToggle={() => setMenuOpen(!menuOpen)}
          onBack={handleBack}
          browserActive={browserActive}
          onStopBrowser={handleStopBrowser}
        />
      )}
      {!isDesktop && (
        <ChatHeader
          session={session}
          streaming={streaming}
          onStop={stopStreaming}
          onMenuToggle={() => setMenuOpen(!menuOpen)}
          mobile
          browserActive={browserActive}
          onStopBrowser={handleStopBrowser}
        />
      )}
      <DevServerBar status={devServerStatus} onStop={handleStopDevServer} />

      {isEmpty ? (
        <div className="flex-1 flex flex-col items-center justify-center px-6 pb-4 relative">
          {/* Atmospheric background glow */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <div className="absolute top-[20%] left-[50%] -translate-x-1/2 w-[500px] h-[300px]"
              style={{
                background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.05) 0%, transparent 70%)',
                animation: 'glow-pulse 6s ease-in-out infinite',
              }} />
          </div>

          <div className="relative max-w-[560px] w-full text-center mb-10"
            style={{ animation: 'fade-in 0.5s cubic-bezier(0.16, 1, 0.3, 1)' }}>
            {/* Sparkle */}
            <div className="flex justify-center mb-5">
              <div className="relative">
                <svg width="32" height="32" viewBox="0 0 48 48" fill="none" className="text-accent-bright"
                  style={{ animation: 'sparkle-spin 8s linear infinite' }}>
                  <path d="M24 4L27.5 18.5L42 24L27.5 29.5L24 44L20.5 29.5L6 24L20.5 18.5L24 4Z"
                    fill="currentColor" opacity="0.8" />
                </svg>
                <div className="absolute inset-0 blur-lg bg-accent-bright/20" />
              </div>
            </div>

            <h1 className="font-display text-[28px] md:text-[36px] font-800 leading-[1.1] tracking-[-0.04em] mb-3">
              Hi{currentUser ? ', ' : ' '}<span className="text-accent-bright">{currentUser || 'there'}</span>
              <br />
              <span className="text-text-2">How can I help?</span>
            </h1>
            <p className="text-[13px] text-text-3 mt-2">
              Pick a prompt or type your own below
            </p>
          </div>

          <div className="relative grid grid-cols-2 md:grid-cols-4 gap-3 max-w-[640px] w-full mb-6">
            {PROMPT_SUGGESTIONS.map((prompt, i) => (
              <button
                key={prompt.text}
                onClick={() => handlePrompt(prompt.text)}
                className={`suggestion-card p-4 rounded-[14px] border border-white/[0.04] bg-gradient-to-br ${prompt.gradient}
                  text-left cursor-pointer flex flex-col gap-3 min-h-[110px] active:scale-[0.97]`}
                style={{ fontFamily: 'inherit', animation: `fade-in 0.4s cubic-bezier(0.16, 1, 0.3, 1) ${i * 0.07 + 0.15}s both` }}
              >
                <PromptIcon type={prompt.icon} />
                <span className="text-[12px] text-text-2/80 leading-snug flex-1">{prompt.text}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <MessageList messages={messages} streaming={streaming} />
      )}

      <SessionDebugPanel
        messages={messages}
        open={debugOpen}
        onClose={() => setDebugOpen(false)}
      />

      <ChatInput
        streaming={streaming}
        onSend={sendMessage}
        onStop={stopStreaming}
      />

      <Dropdown open={menuOpen} onClose={() => setMenuOpen(false)}>
        <DropdownItem onClick={handleDeploy}>Deploy (commit + push)</DropdownItem>
        <DropdownItem onClick={handleDevServer}>
          {devServerStatus?.running ? 'Dev Server Running' : 'Start Dev Server'}
        </DropdownItem>
        <DropdownSep />
        <DropdownItem onClick={() => { setMenuOpen(false); setConfirmClear(true) }}>
          Clear History
        </DropdownItem>
        {!isMainChat && (
          <DropdownItem danger onClick={() => { setMenuOpen(false); setConfirmDelete(true) }}>
            Delete Session
          </DropdownItem>
        )}
      </Dropdown>

      <ConfirmDialog
        open={confirmClear}
        title="Clear History"
        message="This will delete all messages in this session. This cannot be undone."
        confirmLabel="Clear"
        danger
        onConfirm={handleClear}
        onCancel={() => setConfirmClear(false)}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Delete Session"
        message={`Delete "${session.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}

function PromptIcon({ type }: { type: string }) {
  const cls = "w-5 h-5"
  switch (type) {
    case 'book':
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ color: '#818CF8' }}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
    case 'link':
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ color: '#F472B6' }}><path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3" /><line x1="8" y1="12" x2="16" y2="12" /></svg>
    case 'bot':
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ color: '#34D399' }}><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z" /><circle cx="9" cy="13" r="1.25" fill="currentColor" /><circle cx="15" cy="13" r="1.25" fill="currentColor" /><path d="M10 17h4" /></svg>
    case 'check':
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ color: '#FBBF24' }}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
    default:
      return null
  }
}
