'use client'

import { memo, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Message } from '@/types'
import { useAppStore } from '@/stores/use-app-store'
import { AiAvatar } from '@/components/shared/avatar'
import { CodeBlock } from './code-block'
import { ToolCallBubble } from './tool-call-bubble'

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function heartbeatSummary(text: string): string {
  const clean = (text || '')
    .replace(/\bHEARTBEAT_OK\b/gi, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.*?)\]\([^)]+\)/g, '$1')
    .replace(/\bHeartbeat Response\s*:\s*/gi, '')
    .replace(/\bCurrent (State|Status)\s*:\s*/gi, '')
    .replace(/\bRecent Progress\s*:\s*/gi, '')
    .replace(/\bNext (Step|Immediate Step)\s*:\s*/gi, '')
    .replace(/\bStatus\s*:\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return 'No new status update.'
  return clean.length > 180 ? `${clean.slice(0, 180)}...` : clean
}

interface Props {
  message: Message
  assistantName?: string
}

export const MessageBubble = memo(function MessageBubble({ message, assistantName }: Props) {
  const isUser = message.role === 'user'
  const isHeartbeat = !isUser && (message.kind === 'heartbeat' || /^\s*HEARTBEAT_OK\b/i.test(message.text || ''))
  const currentUser = useAppStore((s) => s.currentUser)
  const [copied, setCopied] = useState(false)
  const [heartbeatExpanded, setHeartbeatExpanded] = useState(false)
  const [toolEventsExpanded, setToolEventsExpanded] = useState(false)
  const toolEvents = message.toolEvents || []
  const hasToolEvents = !isUser && toolEvents.length > 0
  const visibleToolEvents = toolEventsExpanded ? [...toolEvents].reverse() : toolEvents.slice(-1)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [message.text])

  return (
    <div
      className={`group ${isUser ? 'flex flex-col items-end' : 'flex flex-col items-start'}`}
      style={{ animation: `${isUser ? 'msg-in-right' : 'msg-in-left'} 0.35s cubic-bezier(0.16, 1, 0.3, 1)` }}
    >
      {/* Sender label + timestamp */}
      <div className={`flex items-center gap-2.5 mb-2 px-1 ${isUser ? 'flex-row-reverse' : ''}`}>
        {!isUser && <AiAvatar size="sm" />}
        <span className={`text-[12px] font-600 ${isUser ? 'text-accent-bright/70' : 'text-text-3'}`}>
          {isUser ? (currentUser ? currentUser.charAt(0).toUpperCase() + currentUser.slice(1) : 'You') : (assistantName || 'Claude')}
        </span>
        <span className="text-[11px] text-text-3/40 font-mono">
          {message.time ? fmtTime(message.time) : ''}
        </span>
      </div>

      {/* Tool call events (assistant messages only) */}
      {hasToolEvents && (
        <div className="max-w-[85%] md:max-w-[72%] flex flex-col gap-2 mb-2">
          {toolEvents.length > 1 && (
            <button
              type="button"
              onClick={() => setToolEventsExpanded((v) => !v)}
              className="self-start px-2.5 py-1 rounded-[8px] bg-white/[0.04] hover:bg-white/[0.07] text-[11px] text-text-3 border border-white/[0.06] cursor-pointer transition-colors"
            >
              {toolEventsExpanded ? 'Show latest only' : `Show all tool calls (${toolEvents.length})`}
            </button>
          )}
          <div className={`${toolEventsExpanded ? 'max-h-[320px] overflow-y-auto pr-1 flex flex-col gap-2' : 'flex flex-col gap-2'}`}>
            {visibleToolEvents.map((event, i) => (
              <ToolCallBubble
                key={`${message.time}-tool-${toolEventsExpanded ? `all-${i}` : `latest-${toolEvents.length - 1}`}`}
                event={{
                  id: `${message.time}-${toolEventsExpanded ? i : toolEvents.length - 1}`,
                  name: event.name,
                  input: event.input,
                  output: event.output,
                  status: event.error ? 'error' : 'done',
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Message bubble */}
      <div className={`max-w-[85%] md:max-w-[72%] ${isUser ? 'bubble-user px-5 py-3.5' : isHeartbeat ? 'bubble-ai px-4 py-3' : 'bubble-ai px-5 py-3.5'}`}>
        {(message.imagePath || message.imageUrl) && (() => {
          const url = message.imageUrl || `/api/uploads/${message.imagePath?.split('/').pop()}`
          const filename = message.imagePath?.split('/').pop()?.replace(/^[a-f0-9]+-/, '') || 'file'
          const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(filename)
          if (isImage) {
            return (
              <img src={url} alt="Attached" className="max-w-[240px] rounded-[12px] mb-3 border border-white/10"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
            )
          }
          return (
            <a href={url} download={filename}
              className="flex items-center gap-3 px-4 py-3 mb-3 rounded-[12px] border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] transition-colors no-underline">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3 shrink-0">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span className="text-[13px] text-text-2 font-500 truncate">{filename}</span>
            </a>
          )
        })()}

        {isHeartbeat ? (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setHeartbeatExpanded((v) => !v)}
              className="w-full rounded-[12px] px-3.5 py-3 border border-white/[0.10] bg-white/[0.02] text-left hover:bg-white/[0.04] transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  <span className="text-[11px] uppercase tracking-[0.08em] text-text-2 font-600">Heartbeat</span>
                </div>
                <span className="text-[11px] text-text-3">{heartbeatExpanded ? 'Collapse' : 'Expand'}</span>
              </div>
              <p className="text-[13px] text-text-2/90 leading-[1.5] mt-1.5">{heartbeatSummary(message.text)}</p>
            </button>
            {heartbeatExpanded && (
              <div className="msg-content text-[14px] leading-[1.7] text-text break-words px-3 py-2 rounded-[10px] border border-white/[0.08] bg-black/20">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={{
                    pre({ children }) {
                      return <pre>{children}</pre>
                    },
                    code({ className, children }) {
                      const isBlock = className?.startsWith('language-') || className?.startsWith('hljs')
                      if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>
                      return <code className={className}>{children}</code>
                    },
                  }}
                >
                  {message.text}
                </ReactMarkdown>
              </div>
            )}
          </div>
        ) : (
          <div className={`msg-content text-[15px] break-words ${isUser ? 'leading-[1.6] text-white/95' : 'leading-[1.7] text-text'}`}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{
                pre({ children }) {
                  return <pre>{children}</pre>
                },
                code({ className, children }) {
                  const isBlock = className?.startsWith('language-') || className?.startsWith('hljs')
                  if (isBlock) {
                    return <CodeBlock className={className}>{children}</CodeBlock>
                  }
                  return <code className={className}>{children}</code>
                },
                img({ src, alt }) {
                  if (!src || typeof src !== 'string') return null
                  const isVideo = /\.(mp4|webm|mov|avi)$/i.test(src)
                  if (isVideo) {
                    return (
                      <video src={src} controls className="max-w-full rounded-[10px] border border-white/10 my-2" />
                    )
                  }
                  return (
                    <a href={src} download target="_blank" rel="noopener noreferrer" className="block my-2">
                      <img src={src} alt={alt || 'File'} className="max-w-full rounded-[10px] border border-white/10 hover:border-white/25 transition-colors cursor-pointer" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    </a>
                  )
                },
                a({ href, children }) {
                  if (!href) return <>{children}</>
                  const isUpload = href.startsWith('/api/uploads/')
                  if (isUpload) {
                    return (
                      <a href={href} download className="inline-flex items-center gap-1.5 text-sky-400 hover:text-sky-300 underline">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        {children}
                      </a>
                    )
                  }
                  // YouTube embed
                  const ytMatch = href.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/)
                  if (ytMatch) {
                    return (
                      <div className="my-2">
                        <iframe
                          src={`https://www.youtube-nocookie.com/embed/${ytMatch[1]}`}
                          className="w-full aspect-video rounded-[10px] border border-white/10"
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                          title="YouTube video"
                        />
                      </div>
                    )
                  }
                  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                },
              }}
            >
              {message.text}
            </ReactMarkdown>
          </div>
        )}
      </div>

      {/* Action buttons (AI messages only) */}
      {!isUser && (
        <div className="flex items-center gap-1 mt-1.5 px-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] border-none bg-transparent
              text-[11px] font-500 text-text-3 cursor-pointer hover:text-text-2 hover:bg-white/[0.04] transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  )
})
