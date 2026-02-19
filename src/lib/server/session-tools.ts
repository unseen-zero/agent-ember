import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawn, spawnSync } from 'child_process'
import * as cheerio from 'cheerio'
import { getMemoryDb } from './memory-db'
import { loadRuntimeSettings } from './runtime-settings'
import {
  clearManagedProcess,
  getManagedProcess,
  killManagedProcess,
  listManagedProcesses,
  pollManagedProcess,
  readManagedProcessLog,
  removeManagedProcess,
  startManagedProcess,
  writeManagedProcessStdin,
} from './process-manager'
import {
  loadAgents, saveAgents,
  loadTasks, saveTasks,
  loadSchedules, saveSchedules,
  loadSkills, saveSkills,
  loadConnectors, saveConnectors,
  loadSecrets, saveSecrets,
  loadSessions, saveSessions,
  UPLOAD_DIR,
  encryptKey,
  decryptKey,
} from './storage'
import { log } from './logger'

const MAX_OUTPUT = 50 * 1024 // 50KB
const MAX_FILE = 100 * 1024 // 100KB

function safePath(cwd: string, filePath: string): string {
  const resolved = path.resolve(cwd, filePath)
  if (!resolved.startsWith(path.resolve(cwd))) {
    throw new Error('Path traversal not allowed')
  }
  return resolved
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n... [truncated at ${max} bytes]`
}

function tail(text: string, max = 4000): string {
  if (!text) return ''
  return text.length <= max ? text : text.slice(text.length - max)
}

function coerceEnvMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

function decodeDuckDuckGoUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl
  try {
    const url = rawUrl.startsWith('http')
      ? new URL(rawUrl)
      : new URL(rawUrl, 'https://duckduckgo.com')
    const uddg = url.searchParams.get('uddg')
    if (uddg) return decodeURIComponent(uddg)
    return url.toString()
  } catch {
    const fromQuery = rawUrl.match(/[?&]uddg=([^&]+)/)?.[1]
    if (fromQuery) {
      try { return decodeURIComponent(fromQuery) } catch { /* noop */ }
    }
    return rawUrl
  }
}

function listDirRecursive(dir: string, depth: number, maxDepth: number): string[] {
  if (depth > maxDepth) return []
  const entries: string[] = []
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true })
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue
      const rel = depth === 0 ? item.name : item.name
      if (item.isDirectory()) {
        entries.push(rel + '/')
        const sub = listDirRecursive(path.join(dir, item.name), depth + 1, maxDepth)
        entries.push(...sub.map((s) => `  ${rel}/${s}`))
      } else {
        entries.push(rel)
      }
    }
  } catch {
    // permission error etc
  }
  return entries
}

interface ToolContext {
  agentId?: string | null
  sessionId?: string | null
  platformAssignScope?: 'self' | 'all'
}

export interface SessionToolsResult {
  tools: StructuredToolInterface[]
  cleanup: () => Promise<void>
}

// Global registry of active browser instances for cleanup sweeps
const activeBrowsers = new Map<string, { client: any; server: any; createdAt: number }>()

/** Kill all browser instances that have been alive longer than maxAge (default 30 min) */
export function sweepOrphanedBrowsers(maxAgeMs = 30 * 60 * 1000): number {
  const now = Date.now()
  let cleaned = 0
  for (const [key, entry] of activeBrowsers) {
    if (now - entry.createdAt > maxAgeMs) {
      try { entry.client?.close?.() } catch { /* ignore */ }
      try { entry.server?.close?.() } catch { /* ignore */ }
      activeBrowsers.delete(key)
      cleaned++
    }
  }
  return cleaned
}

/** Kill a specific session's browser instance */
export function cleanupSessionBrowser(sessionId: string): void {
  const entry = activeBrowsers.get(sessionId)
  if (entry) {
    try { entry.client?.close?.() } catch { /* ignore */ }
    try { entry.server?.close?.() } catch { /* ignore */ }
    activeBrowsers.delete(sessionId)
  }
}

/** Get count of active browser instances */
export function getActiveBrowserCount(): number {
  return activeBrowsers.size
}

/** Check if a specific session has an active browser */
export function hasActiveBrowser(sessionId: string): boolean {
  return activeBrowsers.has(sessionId)
}

export function buildSessionTools(cwd: string, enabledTools: string[], ctx?: ToolContext): SessionToolsResult {
  const tools: StructuredToolInterface[] = []
  const cleanupFns: (() => Promise<void>)[] = []
  const runtime = loadRuntimeSettings()
  const commandTimeoutMs = runtime.shellCommandTimeoutMs
  const claudeTimeoutMs = runtime.claudeCodeTimeoutMs

  if (enabledTools.includes('shell')) {
    tools.push(
      tool(
        async ({ command, background, yieldMs, timeoutSec, env, workdir }) => {
          try {
            const result = await startManagedProcess({
              command,
              cwd: workdir ? safePath(cwd, workdir) : cwd,
              env: coerceEnvMap(env),
              agentId: ctx?.agentId || null,
              sessionId: ctx?.sessionId || null,
              background: !!background,
              yieldMs: typeof yieldMs === 'number' ? yieldMs : undefined,
              timeoutMs: typeof timeoutSec === 'number'
                ? Math.max(1, Math.trunc(timeoutSec)) * 1000
                : commandTimeoutMs,
            })
            if (result.status === 'completed') {
              return truncate(result.output || '(no output)', MAX_OUTPUT)
            }
            return JSON.stringify({
              status: 'running',
              processId: result.processId,
              tail: result.tail || '',
            }, null, 2)
          } catch (err: any) {
            return truncate(`Error: ${err.message || String(err)}`, MAX_OUTPUT)
          }
        },
        {
          name: 'execute_command',
          description: 'Execute a shell command in the session working directory. Supports background mode and timeout/yield controls.',
          schema: z.object({
            command: z.string().describe('The shell command to execute'),
            background: z.boolean().optional().describe('If true, start command in background immediately'),
            yieldMs: z.number().optional().describe('If command runs longer than this, return a running process id instead of blocking'),
            timeoutSec: z.number().optional().describe('Per-command timeout in seconds'),
            workdir: z.string().optional().describe('Relative working directory override'),
            env: z.record(z.string(), z.string()).optional().describe('Environment variable overrides'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('process')) {
    tools.push(
      tool(
        async ({ action, processId, offset, limit, data, eof, signal }) => {
          try {
            if (action === 'list') {
              return JSON.stringify(listManagedProcesses(ctx?.agentId || null).map((p) => ({
                id: p.id,
                command: p.command,
                status: p.status,
                pid: p.pid,
                startedAt: p.startedAt,
                endedAt: p.endedAt,
                exitCode: p.exitCode,
                signal: p.signal,
              })), null, 2)
            }

            if (!processId) return 'Error: processId is required for this action.'

            if (action === 'poll') {
              const res = pollManagedProcess(processId)
              if (!res) return `Process not found: ${processId}`
              return JSON.stringify({
                id: res.process.id,
                status: res.process.status,
                exitCode: res.process.exitCode,
                signal: res.process.signal,
                chunk: res.chunk,
              }, null, 2)
            }

            if (action === 'log') {
              const res = readManagedProcessLog(processId, offset, limit)
              if (!res) return `Process not found: ${processId}`
              return JSON.stringify({
                id: res.process.id,
                status: res.process.status,
                totalLines: res.totalLines,
                text: res.text,
              }, null, 2)
            }

            if (action === 'write') {
              const out = writeManagedProcessStdin(processId, data || '', !!eof)
              return out.ok ? `Wrote to process ${processId}` : `Error: ${out.error}`
            }

            if (action === 'kill') {
              const out = killManagedProcess(processId, (signal as NodeJS.Signals) || 'SIGTERM')
              return out.ok ? `Killed process ${processId}` : `Error: ${out.error}`
            }

            if (action === 'clear') {
              const out = clearManagedProcess(processId)
              return out.ok ? `Cleared process ${processId}` : `Error: ${out.error}`
            }

            if (action === 'remove') {
              const out = removeManagedProcess(processId)
              return out.ok ? `Removed process ${processId}` : `Error: ${out.error}`
            }

            if (action === 'status') {
              const p = getManagedProcess(processId)
              if (!p) return `Process not found: ${processId}`
              return JSON.stringify({
                id: p.id,
                status: p.status,
                pid: p.pid,
                startedAt: p.startedAt,
                endedAt: p.endedAt,
                exitCode: p.exitCode,
                signal: p.signal,
              }, null, 2)
            }

            return `Unknown action "${action}".`
          } catch (err: any) {
            return `Error: ${err.message || String(err)}`
          }
        },
        {
          name: 'process_tool',
          description: 'Manage long-running shell processes started by execute_command. Supports list, status, poll, log, write, kill, clear, and remove.',
          schema: z.object({
            action: z.enum(['list', 'status', 'poll', 'log', 'write', 'kill', 'clear', 'remove']),
            processId: z.string().optional(),
            offset: z.number().optional(),
            limit: z.number().optional(),
            data: z.string().optional(),
            eof: z.boolean().optional(),
            signal: z.string().optional().describe('Signal for kill action, e.g. SIGTERM or SIGKILL'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('files')) {
    tools.push(
      tool(
        async ({ filePath }) => {
          try {
            const resolved = safePath(cwd, filePath)
            const content = fs.readFileSync(resolved, 'utf-8')
            return truncate(content, MAX_FILE)
          } catch (err: any) {
            return `Error reading file: ${err.message}`
          }
        },
        {
          name: 'read_file',
          description: 'Read a file from the session working directory.',
          schema: z.object({
            filePath: z.string().describe('Relative path to the file'),
          }),
        },
      ),
    )

    tools.push(
      tool(
        async ({ filePath, content }) => {
          try {
            const resolved = safePath(cwd, filePath)
            fs.mkdirSync(path.dirname(resolved), { recursive: true })
            fs.writeFileSync(resolved, content, 'utf-8')
            return `File written: ${filePath} (${content.length} bytes)`
          } catch (err: any) {
            return `Error writing file: ${err.message}`
          }
        },
        {
          name: 'write_file',
          description: 'Write content to a file in the session working directory. Creates directories if needed.',
          schema: z.object({
            filePath: z.string().describe('Relative path to the file'),
            content: z.string().describe('The content to write'),
          }),
        },
      ),
    )

    tools.push(
      tool(
        async ({ dirPath }) => {
          try {
            const resolved = safePath(cwd, dirPath || '.')
            const tree = listDirRecursive(resolved, 0, 3)
            return tree.length ? tree.join('\n') : '(empty directory)'
          } catch (err: any) {
            return `Error listing files: ${err.message}`
          }
        },
        {
          name: 'list_files',
          description: 'List files in the session working directory recursively (max depth 3).',
          schema: z.object({
            dirPath: z.string().optional().describe('Relative path to list (defaults to working directory)'),
          }),
        },
      ),
    )
  }

  // send_file is always available when files tool is enabled — lets agents share any file with the user
  if (enabledTools.includes('files')) {
    tools.push(
      tool(
        async ({ filePath: rawPath }) => {
          try {
            // Resolve relative to cwd, but also allow absolute paths
            const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath)
            if (!fs.existsSync(resolved)) return `Error: file not found: ${rawPath}`
            const stat = fs.statSync(resolved)
            if (stat.isDirectory()) return `Error: cannot send a directory. Send individual files instead.`
            if (stat.size > 100 * 1024 * 1024) return `Error: file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max 100MB.`

            const ext = path.extname(resolved).slice(1).toLowerCase()
            const basename = path.basename(resolved)
            const filename = `${Date.now()}-${basename}`
            const dest = path.join(UPLOAD_DIR, filename)
            fs.copyFileSync(resolved, dest)

            const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']
            const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'avi', 'mkv']

            if (IMAGE_EXTS.includes(ext)) {
              return `![${basename}](/api/uploads/${filename})`
            } else if (VIDEO_EXTS.includes(ext)) {
              return `![${basename}](/api/uploads/${filename})`
            } else {
              return `[Download ${basename}](/api/uploads/${filename})`
            }
          } catch (err: any) {
            return `Error sending file: ${err.message}`
          }
        },
        {
          name: 'send_file',
          description: 'Send a file to the user so they can view or download it in the chat. Works with images, videos, PDFs, documents, and any other file type. The file will appear inline for images/videos, or as a download link for other types.',
          schema: z.object({
            filePath: z.string().describe('Path to the file (relative to working directory, or absolute)'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('claude_code')) {
    tools.push(
      tool(
        async ({ task }) => {
          try {
            const env: NodeJS.ProcessEnv = { ...process.env }
            // Running inside Claude environments can block nested `claude` launches.
            // Strip all CLAUDE* vars so delegation can run as an independent subprocess.
            const removedClaudeEnvKeys: string[] = []
            for (const key of Object.keys(env)) {
              if (key.toUpperCase().startsWith('CLAUDE')) {
                removedClaudeEnvKeys.push(key)
                delete env[key]
              }
            }

            // Fast preflight: when Claude isn't authenticated, surface a clear error immediately.
            const authProbe = spawnSync('claude', ['auth', 'status'], {
              cwd,
              env,
              encoding: 'utf-8',
              timeout: 8000,
            })
            if ((authProbe.status ?? 1) !== 0) {
              let loggedIn = false
              try {
                const parsed = JSON.parse(authProbe.stdout || '{}') as { loggedIn?: boolean }
                loggedIn = parsed.loggedIn === true
              } catch {
                // ignore parse issues and fall back to a generic auth guidance
              }
              if (!loggedIn) {
                return 'Error: Claude Code CLI is not authenticated. Run `claude auth login` (or `claude setup-token`) on this machine, then retry.'
              }
            }

            log.info('session-tools', 'delegate_to_claude_code start', {
              sessionId: ctx?.sessionId || null,
              agentId: ctx?.agentId || null,
              cwd,
              timeoutMs: claudeTimeoutMs,
              removedClaudeEnvKeys,
              taskPreview: (task || '').slice(0, 200),
            })

            return new Promise<string>((resolve) => {
              const args = ['--print', '--output-format', 'text', '--dangerously-skip-permissions']
              const child = spawn('claude', args, {
                cwd,
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
              })
              let stdout = ''
              let stderr = ''
              let settled = false
              let timedOut = false
              const startedAt = Date.now()

              const finish = (result: string) => {
                if (settled) return
                settled = true
                resolve(truncate(result, MAX_OUTPUT))
              }

              const timeoutHandle = setTimeout(() => {
                timedOut = true
                try { child.kill('SIGTERM') } catch { /* ignore */ }
                setTimeout(() => {
                  try { child.kill('SIGKILL') } catch { /* ignore */ }
                }, 5000)
              }, claudeTimeoutMs)

              log.info('session-tools', 'delegate_to_claude_code spawned', {
                sessionId: ctx?.sessionId || null,
                pid: child.pid || null,
                args,
              })
              child.stdout?.on('data', (chunk: Buffer) => {
                stdout += chunk.toString()
                if (stdout.length > MAX_OUTPUT * 8) stdout = tail(stdout, MAX_OUTPUT * 8)
              })
              child.stderr?.on('data', (chunk: Buffer) => {
                stderr += chunk.toString()
                if (stderr.length > MAX_OUTPUT * 8) stderr = tail(stderr, MAX_OUTPUT * 8)
              })
              child.on('error', (err) => {
                clearTimeout(timeoutHandle)
                log.error('session-tools', 'delegate_to_claude_code child error', {
                  sessionId: ctx?.sessionId || null,
                  error: err?.message || String(err),
                })
                finish(`Error: failed to start Claude Code CLI: ${err?.message || String(err)}`)
              })
              child.on('close', (code, signal) => {
                clearTimeout(timeoutHandle)
                const durationMs = Date.now() - startedAt
                log.info('session-tools', 'delegate_to_claude_code child close', {
                  sessionId: ctx?.sessionId || null,
                  code,
                  signal: signal || null,
                  timedOut,
                  durationMs,
                  stdoutLen: stdout.length,
                  stderrLen: stderr.length,
                  stderrPreview: tail(stderr, 240),
                })
                if (timedOut) {
                  const msg = [
                    `Error: Claude Code CLI timed out after ${Math.round(claudeTimeoutMs / 1000)}s.`,
                    stderr.trim() ? `stderr:\n${tail(stderr, 1500)}` : '',
                    stdout.trim() ? `stdout:\n${tail(stdout, 1500)}` : '',
                    'Try increasing "Claude Code Timeout (sec)" in Settings.',
                  ].filter(Boolean).join('\n\n')
                  finish(msg)
                  return
                }

                if (code === 0 && (stdout.trim() || stderr.trim())) {
                  finish(stdout.trim() || stderr.trim())
                  return
                }

                const msg = [
                  `Error: Claude Code CLI exited with code ${code ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}.`,
                  stderr.trim() ? `stderr:\n${tail(stderr, 1500)}` : '',
                  stdout.trim() ? `stdout:\n${tail(stdout, 1500)}` : '',
                ].filter(Boolean).join('\n\n')
                finish(msg || 'Error: Claude Code CLI returned no output.')
              })

              try {
                child.stdin?.write(task)
                child.stdin?.end()
              } catch (err: any) {
                clearTimeout(timeoutHandle)
                finish(`Error: failed to send task to Claude Code CLI: ${err?.message || String(err)}`)
              }
            })
          } catch (err: any) {
            return `Error delegating to Claude Code: ${err.message}`
          }
        },
        {
          name: 'delegate_to_claude_code',
          description: 'Delegate a complex task to Claude Code CLI. Use for tasks that need deep code understanding, multi-file refactoring, or running tests. The task runs in the session working directory.',
          schema: z.object({
            task: z.string().describe('Detailed description of the task for Claude Code'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('edit_file')) {
    tools.push(
      tool(
        async ({ filePath, oldText, newText }) => {
          try {
            const resolved = safePath(cwd, filePath)
            if (!fs.existsSync(resolved)) return `Error: File not found: ${filePath}`
            const content = fs.readFileSync(resolved, 'utf-8')
            const count = content.split(oldText).length - 1
            if (count === 0) return `Error: oldText not found in ${filePath}`
            if (count > 1) return `Error: oldText found ${count} times in ${filePath}. Make it more specific.`
            const updated = content.replace(oldText, newText)
            fs.writeFileSync(resolved, updated, 'utf-8')
            return `Successfully edited ${filePath}`
          } catch (err: any) {
            return `Error editing file: ${err.message}`
          }
        },
        {
          name: 'edit_file',
          description: 'Search and replace text in a file. The oldText must match exactly once in the file.',
          schema: z.object({
            filePath: z.string().describe('Relative path to the file'),
            oldText: z.string().describe('Exact text to find (must be unique in the file)'),
            newText: z.string().describe('Text to replace it with'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('web_search')) {
    tools.push(
      tool(
        async ({ query, maxResults }) => {
          try {
            const limit = Math.min(maxResults || 5, 10)
            const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
            const res = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SwarmClaw/1.0)' },
              signal: AbortSignal.timeout(15000),
            })
            if (!res.ok) {
              return `Error searching web: HTTP ${res.status} ${res.statusText}`
            }
            const html = await res.text()
            const $ = cheerio.load(html)
            const results: { title: string; url: string; snippet: string }[] = []

            // Primary parser: DuckDuckGo result cards
            $('.result').each((_i, el) => {
              if (results.length >= limit) return false
              const link = $(el).find('a.result__a').first()
              const rawHref = link.attr('href') || ''
              const title = link.text().replace(/\s+/g, ' ').trim()
              if (!rawHref || !title) return
              const snippet = $(el).find('.result__snippet').first().text().replace(/\s+/g, ' ').trim()
              results.push({
                title,
                url: decodeDuckDuckGoUrl(rawHref),
                snippet,
              })
            })

            // Fallback parser: any result__a anchors
            if (results.length === 0) {
              $('a.result__a').each((_i, el) => {
                if (results.length >= limit) return false
                const rawHref = $(el).attr('href') || ''
                const title = $(el).text().replace(/\s+/g, ' ').trim()
                if (!rawHref || !title) return
                results.push({
                  title,
                  url: decodeDuckDuckGoUrl(rawHref),
                  snippet: '',
                })
              })
            }

            return results.length > 0
              ? JSON.stringify(results, null, 2)
              : 'No results found.'
          } catch (err: any) {
            return `Error searching web: ${err.message}`
          }
        },
        {
          name: 'web_search',
          description: 'Search the web using DuckDuckGo. Returns an array of results with title, url, and snippet.',
          schema: z.object({
            query: z.string().describe('Search query'),
            maxResults: z.number().optional().describe('Maximum results to return (default 5, max 10)'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('web_fetch')) {
    tools.push(
      tool(
        async ({ url }) => {
          try {
            const res = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SwarmClaw/1.0)' },
              signal: AbortSignal.timeout(15000),
            })
            if (!res.ok) return `HTTP ${res.status}: ${res.statusText}`
            const html = await res.text()
            // Use cheerio for robust HTML text extraction
            const $ = cheerio.load(html)
            $('script, style, noscript, nav, footer, header').remove()
            // Prefer article/main content if available
            const main = $('article, main, [role="main"]').first()
            let text = (main.length ? main.text() : $('body').text())
              .replace(/\s+/g, ' ')
              .trim()
            return truncate(text, MAX_OUTPUT)
          } catch (err: any) {
            return `Error fetching URL: ${err.message}`
          }
        },
        {
          name: 'web_fetch',
          description: 'Fetch a URL and return its text content (HTML stripped). Useful for reading web pages.',
          schema: z.object({
            url: z.string().describe('The URL to fetch'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('browser')) {
    // In-process Playwright MCP client via @playwright/mcp programmatic API
    const sessionKey = ctx?.sessionId || `anon-${Date.now()}`
    let mcpClient: any = null
    let mcpServer: any = null
    let mcpInitializing: Promise<void> | null = null

    const ensureMcp = (): Promise<void> => {
      if (mcpClient) return Promise.resolve()
      if (mcpInitializing) return mcpInitializing
      mcpInitializing = (async () => {
        const { createConnection } = await import('@playwright/mcp')
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
        const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

        const server = await createConnection({
          browser: {
            launchOptions: { headless: true },
            isolated: true,
          },
          imageResponses: 'allow',
          capabilities: ['core', 'pdf', 'vision', 'network'],
        })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        const client = new Client({ name: 'swarmclaw', version: '1.0' })
        await Promise.all([
          client.connect(clientTransport),
          server.connect(serverTransport),
        ])
        mcpClient = client
        mcpServer = server
        // Register in global tracker
        activeBrowsers.set(sessionKey, { client, server, createdAt: Date.now() })
      })()
      return mcpInitializing
    }

    // Register cleanup for this session's browser
    cleanupFns.push(async () => {
      try { mcpClient?.close?.() } catch { /* ignore */ }
      try { mcpServer?.close?.() } catch { /* ignore */ }
      activeBrowsers.delete(sessionKey)
      mcpClient = null
      mcpServer = null
    })

    /** Strip Playwright debug noise — keep page context for the LLM */
    const cleanPlaywrightOutput = (text: string): string => {
      // Remove "### Ran Playwright code" blocks (internal debug)
      text = text.replace(/### Ran Playwright code[\s\S]*?(?=###|$)/g, '')
      // Truncate snapshot to first 40 lines so LLM has page context without flooding
      text = text.replace(/### Snapshot\n([\s\S]*?)(?=###|$)/g, (_match, snapshot) => {
        const lines = (snapshot as string).split('\n')
        if (lines.length > 40) {
          return 'Page elements:\n' + lines.slice(0, 40).join('\n') + '\n... (truncated)\n'
        }
        return 'Page elements:\n' + snapshot
      })
      // Clean headers
      text = text.replace(/^### Result\n/gm, '')
      text = text.replace(/^### Page\n/gm, '')
      return text.replace(/\n{3,}/g, '\n').trim()
    }

    const callMcpTool = async (toolName: string, args: Record<string, any>): Promise<string> => {
      await ensureMcp()
      const result = await mcpClient.callTool({ name: toolName, arguments: args })
      const isError = result?.isError === true
      const content = result?.content
      if (Array.isArray(content)) {
        const parts: string[] = []
        let hasBinaryImage = false
        for (const c of content) {
          if (c.type === 'image' && c.data) {
            hasBinaryImage = true
            const filename = `screenshot-${Date.now()}.png`
            const filepath = path.join(UPLOAD_DIR, filename)
            fs.writeFileSync(filepath, Buffer.from(c.data, 'base64'))
            parts.push(`![Screenshot](/api/uploads/${filename})`)
          } else if (c.type === 'resource' && c.resource?.blob) {
            const ext = c.resource.mimeType?.includes('pdf') ? 'pdf' : 'bin'
            const filename = `browser-${Date.now()}.${ext}`
            const filepath = path.join(UPLOAD_DIR, filename)
            fs.writeFileSync(filepath, Buffer.from(c.resource.blob, 'base64'))
            parts.push(`[Download ${filename}](/api/uploads/${filename})`)
          } else {
            let text = c.text || ''
            // Detect file paths in output (e.g. PDF save returns a local path)
            const fileMatch = text.match(/\]\((\.\.\/[^\s)]+|\/[^\s)]+\.(pdf|png|jpg|jpeg|gif|webp|html|mp4|webm))\)/)
            if (fileMatch) {
              const rawPath = fileMatch[1]
              const srcPath = rawPath.startsWith('/') ? rawPath : path.resolve(process.cwd(), rawPath)
              if (fs.existsSync(srcPath)) {
                const ext = path.extname(srcPath).slice(1).toLowerCase()
                const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp']
                // Skip file-path images if we already have a binary image (avoids duplicates)
                if (IMAGE_EXTS.includes(ext) && hasBinaryImage) {
                  parts.push(isError ? text : cleanPlaywrightOutput(text))
                } else {
                  const filename = `browser-${Date.now()}.${ext}`
                  const destPath = path.join(UPLOAD_DIR, filename)
                  fs.copyFileSync(srcPath, destPath)
                  if (IMAGE_EXTS.includes(ext)) {
                    parts.push(`![Screenshot](/api/uploads/${filename})`)
                  } else {
                    parts.push(`[Download ${filename}](/api/uploads/${filename})`)
                  }
                }
              } else {
                parts.push(isError ? text : cleanPlaywrightOutput(text))
              }
            } else {
              parts.push(isError ? text : cleanPlaywrightOutput(text))
            }
          }
        }
        return parts.join('\n')
      }
      return JSON.stringify(result)
    }

    // Action-to-MCP tool mapping
    const MCP_TOOL_MAP: Record<string, string> = {
      navigate: 'browser_navigate',
      screenshot: 'browser_take_screenshot',
      snapshot: 'browser_snapshot',
      click: 'browser_click',
      type: 'browser_type',
      press_key: 'browser_press_key',
      select: 'browser_select_option',
      evaluate: 'browser_evaluate',
      pdf: 'browser_pdf_save',
      upload: 'browser_file_upload',
      wait: 'browser_wait_for',
    }

    tools.push(
      tool(
        async (params) => {
          try {
            const { action, ...rest } = params
            // Build MCP args based on action
            const mcpTool = MCP_TOOL_MAP[action]
            if (!mcpTool) return `Unknown browser action: "${action}". Valid: ${Object.keys(MCP_TOOL_MAP).join(', ')}`
            // Pass only defined (non-undefined) params to MCP
            const args: Record<string, any> = {}
            for (const [k, v] of Object.entries(rest)) {
              if (v !== undefined && v !== null && v !== '') args[k] = v
            }
            return await callMcpTool(mcpTool, args)
          } catch (err: any) {
            return `Error: ${err.message}`
          }
        },
        {
          name: 'browser',
          description: [
            'Control the browser. Use action to specify what to do.',
            'Actions: navigate (url), screenshot, snapshot (get page elements), click (element/ref), type (element/ref, text), press_key (key), select (element/ref, option), evaluate (expression), pdf, upload (paths, ref), wait (text/timeout).',
            'Workflow: use snapshot to see the page and get element refs, then use click/type/select with those refs.',
            'Screenshots are returned as images visible to the user.',
          ].join(' '),
          schema: z.object({
            action: z.enum(['navigate', 'screenshot', 'snapshot', 'click', 'type', 'press_key', 'select', 'evaluate', 'pdf', 'upload', 'wait']).describe('The browser action to perform'),
            url: z.string().optional().describe('URL to navigate to (for navigate action)'),
            element: z.string().optional().describe('CSS selector or description of an element (for click/type/select)'),
            ref: z.string().optional().describe('Element reference from a previous snapshot (for click/type/select/upload)'),
            text: z.string().optional().describe('Text to type (for type action) or text to wait for (for wait action)'),
            key: z.string().optional().describe('Key to press, e.g. Enter, Tab, Escape (for press_key action)'),
            option: z.string().optional().describe('Option value or label to select (for select action)'),
            expression: z.string().optional().describe('JavaScript expression to evaluate (for evaluate action)'),
            paths: z.array(z.string()).optional().describe('File paths to upload (for upload action)'),
            timeout: z.number().optional().describe('Timeout in milliseconds (for wait action, default 30000)'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('memory')) {
    const memDb = getMemoryDb()

    tools.push(
      tool(
        async ({ action, key, value, category, query, scope }) => {
          try {
            const scopeMode = scope || 'auto'
            const currentAgentId = ctx?.agentId || null
            const canAccessMemory = (m: any) => !m?.agentId || m.agentId === currentAgentId
            const filterScope = (rows: any[]) => {
              if (scopeMode === 'shared') return rows.filter((m) => !m.agentId)
              if (scopeMode === 'agent') return rows.filter((m) => currentAgentId && m.agentId === currentAgentId)
              // auto: shared + this agent's memories
              return rows.filter(canAccessMemory)
            }

            if (action === 'store') {
              const entry = memDb.add({
                agentId: scopeMode === 'shared' ? null : currentAgentId,
                sessionId: ctx?.sessionId || null,
                category: category || 'note',
                title: key,
                content: value || '',
              })
              const memoryScope = entry.agentId ? 'agent' : 'shared'
              return `Stored ${memoryScope} memory "${key}" (id: ${entry.id})`
            }
            if (action === 'get') {
              const found = memDb.get(key)
              if (!found) return `Memory not found: ${key}`
              if (!canAccessMemory(found)) return 'Error: you do not have access to that memory.'
              const owner = found.agentId ? `agent:${found.agentId}` : 'shared'
              return `[${found.id}] (${owner}) ${found.category}/${found.title}: ${found.content}`
            }
            if (action === 'search') {
              const results = filterScope(memDb.search(query || key))
              if (!results.length) return 'No memories found.'
              return results.map((m) => `[${m.id}] (${m.agentId ? `agent:${m.agentId}` : 'shared'}) ${m.title}: ${m.content}`).join('\n')
            }
            if (action === 'list') {
              const results = filterScope(memDb.list())
              if (!results.length) return 'No memories stored yet.'
              return results.map((m) => `[${m.id}] (${m.agentId ? `agent:${m.agentId}` : 'shared'}) ${m.category}/${m.title}: ${m.content}`).join('\n')
            }
            if (action === 'delete') {
              const found = memDb.get(key)
              if (!found) return `Memory not found: ${key}`
              if (!canAccessMemory(found)) return 'Error: you do not have access to that memory.'
              memDb.delete(key)
              return `Deleted memory "${key}"`
            }
            return `Unknown action "${action}". Use: store, get, search, list, or delete.`
          } catch (err: any) {
            return `Error: ${err.message}`
          }
        },
        {
          name: 'memory_tool',
          description: 'Store and retrieve long-term memories that persist across sessions. Memories can be shared or agent-scoped. Use "store", "get", "search", "list", and "delete".',
          schema: z.object({
            action: z.enum(['store', 'get', 'search', 'list', 'delete']).describe('The action to perform'),
            key: z.string().describe('For store: memory title. For get/delete: memory ID. For search: optional query fallback.'),
            value: z.string().optional().describe('The memory content (for store action)'),
            category: z.string().optional().describe('Category like "note", "fact", "preference" (for store action, defaults to "note")'),
            query: z.string().optional().describe('Search query (alternative to key for search action)'),
            scope: z.enum(['auto', 'shared', 'agent']).optional().describe('Scope hint: auto (shared + own), shared, or agent'),
          }),
        },
      ),
    )
  }

  // Platform management tools — each resource type is a separate toggleable tool
  const RESOURCE_DEFAULTS: Record<string, (parsed: any) => any> = {
    manage_agents: (p) => ({
      name: p.name || 'Unnamed Agent',
      description: p.description || '',
      systemPrompt: p.systemPrompt || '',
      soul: p.soul || '',
      provider: p.provider || 'claude-cli',
      model: p.model || '',
      isOrchestrator: p.isOrchestrator || false,
      tools: p.tools || [],
      skills: p.skills || [],
      skillIds: p.skillIds || [],
      subAgentIds: p.subAgentIds || [],
      ...p,
    }),
    manage_tasks: (p) => ({
      title: p.title || 'Untitled Task',
      description: p.description || '',
      status: p.status || 'backlog',
      agentId: p.agentId || null,
      sessionId: p.sessionId || null,
      result: null,
      error: null,
      queuedAt: null,
      startedAt: null,
      completedAt: null,
      ...p,
    }),
    manage_schedules: (p) => {
      const now = Date.now()
      const base = {
        name: p.name || 'Unnamed Schedule',
        agentId: p.agentId || null,
        taskPrompt: p.taskPrompt || '',
        scheduleType: p.scheduleType || 'interval',
        status: p.status || 'active',
        ...p,
      }
      if (!base.nextRunAt) {
        if (base.scheduleType === 'once' && base.runAt) base.nextRunAt = base.runAt
        else if (base.scheduleType === 'interval' && base.intervalMs) base.nextRunAt = now + base.intervalMs
      }
      return base
    },
    manage_skills: (p) => ({
      name: p.name || 'Unnamed Skill',
      description: p.description || '',
      content: p.content || '',
      filename: p.filename || '',
      ...p,
    }),
    manage_connectors: (p) => ({
      name: p.name || 'Unnamed Connector',
      platform: p.platform || 'discord',
      agentId: p.agentId || null,
      enabled: p.enabled ?? false,
      ...p,
    }),
    manage_secrets: (p) => ({
      name: p.name || 'Unnamed Secret',
      service: p.service || 'custom',
      scope: p.scope || 'global',
      agentIds: Array.isArray(p.agentIds) ? p.agentIds : [],
      ...p,
    }),
  }

  const PLATFORM_RESOURCES: Record<string, {
    toolId: string
    label: string
    load: () => Record<string, any>
    save: (d: Record<string, any>) => void
    readOnly?: boolean
  }> = {
    manage_agents: { toolId: 'manage_agents', label: 'agents', load: loadAgents, save: saveAgents },
    manage_tasks: { toolId: 'manage_tasks', label: 'tasks', load: loadTasks, save: saveTasks },
    manage_schedules: { toolId: 'manage_schedules', label: 'schedules', load: loadSchedules, save: saveSchedules },
    manage_skills: { toolId: 'manage_skills', label: 'skills', load: loadSkills, save: saveSkills },
    manage_connectors: { toolId: 'manage_connectors', label: 'connectors', load: loadConnectors, save: saveConnectors },
    manage_sessions: { toolId: 'manage_sessions', label: 'sessions', load: loadSessions, save: saveSessions, readOnly: true },
    manage_secrets: { toolId: 'manage_secrets', label: 'secrets', load: loadSecrets, save: saveSecrets },
  }

  // Build dynamic agent summary for tools that need agent awareness
  const assignScope = ctx?.platformAssignScope || 'self'
  let agentSummary = ''
  if (enabledTools.includes('manage_tasks') || enabledTools.includes('manage_schedules')) {
    if (assignScope === 'all') {
      try {
        const agents = loadAgents()
        const agentList = Object.values(agents)
          .map((a: any) => `  - "${a.id}": ${a.name}${a.description ? ` — ${a.description}` : ''}`)
          .join('\n')
        if (agentList) agentSummary = `\n\nAvailable agents:\n${agentList}`
      } catch { /* ignore */ }
    }
  }

  for (const [toolKey, res] of Object.entries(PLATFORM_RESOURCES)) {
    if (!enabledTools.includes(toolKey)) continue

    let description = `Manage SwarmClaw ${res.label}. ${res.readOnly ? 'List and get only.' : 'List, get, create, update, or delete.'} Returns JSON.`
    if (toolKey === 'manage_tasks') {
      if (assignScope === 'self') {
        description += `\n\nSet "agentId" to assign a task to yourself ("${ctx?.agentId || 'unknown'}") or leave it null. You can only assign tasks to yourself. Valid statuses: backlog, queued, running, completed, failed.`
      } else {
        description += `\n\nSet "agentId" to assign a task to an agent (including yourself: "${ctx?.agentId || 'unknown'}"). Valid statuses: backlog, queued, running, completed, failed.` + agentSummary
      }
    } else if (toolKey === 'manage_agents') {
      description += `\n\nAgents may self-edit their own soul. To update your soul, use action="update", id="${ctx?.agentId || 'your-agent-id'}", and include data with the "soul" field.`
    } else if (toolKey === 'manage_schedules') {
      if (assignScope === 'self') {
        description += `\n\nSet "agentId" to assign a schedule to yourself ("${ctx?.agentId || 'unknown'}") or leave it null. You can only assign schedules to yourself. Schedule types: interval (set intervalMs), cron (set cron), once (set runAt). Set taskPrompt for what the agent should do.`
      } else {
        description += `\n\nSet "agentId" to assign a schedule to an agent (including yourself: "${ctx?.agentId || 'unknown'}"). Schedule types: interval (set intervalMs), cron (set cron), once (set runAt). Set taskPrompt for what the agent should do.` + agentSummary
      }
    }

    tools.push(
      tool(
        async ({ action, id, data }) => {
          const canAccessSecret = (secret: any): boolean => {
            if (!secret) return false
            if (secret.scope !== 'agent') return true
            if (!ctx?.agentId) return false
            return Array.isArray(secret.agentIds) && secret.agentIds.includes(ctx.agentId)
          }
          try {
            if (action === 'list') {
              if (toolKey === 'manage_secrets') {
                const values = Object.values(res.load())
                  .filter((s: any) => canAccessSecret(s))
                  .map((s: any) => ({
                    id: s.id,
                    name: s.name,
                    service: s.service,
                    scope: s.scope || 'global',
                    agentIds: s.agentIds || [],
                    createdAt: s.createdAt,
                    updatedAt: s.updatedAt,
                  }))
                return JSON.stringify(values)
              }
              return JSON.stringify(Object.values(res.load()))
            }
            if (action === 'get') {
              if (!id) return 'Error: "id" is required for get action.'
              const all = res.load()
              if (!all[id]) return `Not found: ${res.label} "${id}"`
              if (toolKey === 'manage_secrets') {
                if (!canAccessSecret(all[id])) return 'Error: you do not have access to this secret.'
                let value = ''
                try {
                  value = all[id].encryptedValue ? decryptKey(all[id].encryptedValue) : ''
                } catch {
                  value = ''
                }
                return JSON.stringify({
                  id: all[id].id,
                  name: all[id].name,
                  service: all[id].service,
                  scope: all[id].scope || 'global',
                  agentIds: all[id].agentIds || [],
                  value,
                  createdAt: all[id].createdAt,
                  updatedAt: all[id].updatedAt,
                })
              }
              return JSON.stringify(all[id])
            }
            if (res.readOnly) return `Cannot ${action} ${res.label} via this tool (read-only).`
            if (action === 'create') {
              const all = res.load()
              const newId = crypto.randomBytes(4).toString('hex')
              const raw = data ? JSON.parse(data) : {}
              const defaults = RESOURCE_DEFAULTS[toolKey]
              const parsed = defaults ? defaults(raw) : raw
              if (parsed && typeof parsed === 'object' && 'id' in parsed) {
                delete (parsed as Record<string, unknown>).id
              }
              // Enforce assignment scope for tasks and schedules
              if (assignScope === 'self' && (toolKey === 'manage_tasks' || toolKey === 'manage_schedules')) {
                if (parsed.agentId && parsed.agentId !== ctx?.agentId) {
                  return `Error: You can only assign ${res.label} to yourself ("${ctx?.agentId}"). To assign to other agents, ask a user to enable "Assign to Other Agents" in your agent settings.`
                }
              }
              const now = Date.now()
              const entry = {
                id: newId,
                ...parsed,
                createdByAgentId: ctx?.agentId || null,
                createdInSessionId: ctx?.sessionId || null,
                createdAt: now,
                updatedAt: now,
              }
              let responseEntry: any = entry
              if (toolKey === 'manage_secrets') {
                const secretValue = typeof parsed.value === 'string' ? parsed.value : null
                if (!secretValue) return 'Error: data.value is required to create a secret.'
                const normalizedScope = parsed.scope === 'agent' ? 'agent' : 'global'
                const normalizedAgentIds = normalizedScope === 'agent'
                  ? Array.from(new Set([
                      ...(Array.isArray(parsed.agentIds) ? parsed.agentIds.filter((x: any) => typeof x === 'string') : []),
                      ...(ctx?.agentId ? [ctx.agentId] : []),
                    ]))
                  : []
                const stored = {
                  ...entry,
                  scope: normalizedScope,
                  agentIds: normalizedAgentIds,
                  encryptedValue: encryptKey(secretValue),
                }
                delete (stored as any).value
                all[newId] = stored
                const { encryptedValue, ...safe } = stored
                responseEntry = safe
              } else {
                all[newId] = entry
              }
              res.save(all)
              if (toolKey === 'manage_tasks' && entry.status === 'queued') {
                const { enqueueTask } = await import('./queue')
                enqueueTask(newId)
              }
              return JSON.stringify(responseEntry)
            }
            if (action === 'update') {
              if (!id) return 'Error: "id" is required for update action.'
              const all = res.load()
              if (!all[id]) return `Not found: ${res.label} "${id}"`
              const parsed = data ? JSON.parse(data) : {}
              const prevStatus = all[id]?.status
              // Enforce assignment scope for tasks and schedules
              if (assignScope === 'self' && (toolKey === 'manage_tasks' || toolKey === 'manage_schedules')) {
                if (parsed.agentId && parsed.agentId !== ctx?.agentId) {
                  return `Error: You can only assign ${res.label} to yourself ("${ctx?.agentId}"). To assign to other agents, ask a user to enable "Assign to Other Agents" in your agent settings.`
                }
              }
              all[id] = { ...all[id], ...parsed, updatedAt: Date.now() }
              if (toolKey === 'manage_secrets') {
                if (!canAccessSecret(all[id])) return 'Error: you do not have access to this secret.'
                const nextScope = parsed.scope === 'agent'
                  ? 'agent'
                  : parsed.scope === 'global'
                    ? 'global'
                    : (all[id].scope === 'agent' ? 'agent' : 'global')
                if (nextScope === 'agent') {
                  const incomingIds = Array.isArray(parsed.agentIds)
                    ? parsed.agentIds.filter((x: any) => typeof x === 'string')
                    : Array.isArray(all[id].agentIds)
                      ? all[id].agentIds
                      : []
                  all[id].agentIds = Array.from(new Set([
                    ...incomingIds,
                    ...(ctx?.agentId ? [ctx.agentId] : []),
                  ]))
                } else {
                  all[id].agentIds = []
                }
                all[id].scope = nextScope
                if (typeof parsed.value === 'string' && parsed.value.trim()) {
                  all[id].encryptedValue = encryptKey(parsed.value)
                }
                delete all[id].value
              }
              res.save(all)
              if (toolKey === 'manage_tasks' && prevStatus !== 'queued' && all[id].status === 'queued') {
                const { enqueueTask } = await import('./queue')
                enqueueTask(id)
              }
              if (toolKey === 'manage_secrets') {
                const { encryptedValue, ...safe } = all[id]
                return JSON.stringify(safe)
              }
              return JSON.stringify(all[id])
            }
            if (action === 'delete') {
              if (!id) return 'Error: "id" is required for delete action.'
              const all = res.load()
              if (!all[id]) return `Not found: ${res.label} "${id}"`
              if (toolKey === 'manage_secrets' && !canAccessSecret(all[id])) {
                return 'Error: you do not have access to this secret.'
              }
              delete all[id]
              res.save(all)
              return JSON.stringify({ deleted: id })
            }
            return `Unknown action "${action}". Valid: list, get, create, update, delete`
          } catch (err: any) {
            return `Error: ${err.message}`
          }
        },
        {
          name: toolKey,
          description,
          schema: z.object({
            action: z.enum(['list', 'get', 'create', 'update', 'delete']).describe('The CRUD action to perform'),
            id: z.string().optional().describe('Resource ID (required for get, update, delete)'),
            data: z.string().optional().describe('JSON string of fields for create/update'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('manage_sessions')) {
    tools.push(
      tool(
        async ({ action, sessionId, message, limit, agentId, name, waitForReply, timeoutSec, queueMode, heartbeatEnabled, finalStatus }) => {
          try {
            const sessions = loadSessions()
            if (action === 'list') {
              const { getSessionRunState } = await import('./session-run-manager')
              const items = Object.values(sessions)
                .sort((a: any, b: any) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
                .slice(0, Math.max(1, Math.min(limit || 50, 200)))
                .map((s: any) => {
                  const runState = getSessionRunState(s.id)
                  return {
                    id: s.id,
                    name: s.name,
                    sessionType: s.sessionType || 'human',
                    agentId: s.agentId || null,
                    provider: s.provider,
                    model: s.model,
                    parentSessionId: s.parentSessionId || null,
                    active: !!runState.runningRunId,
                    queuedCount: runState.queueLength,
                    heartbeatEnabled: s.heartbeatEnabled !== false,
                    lastActiveAt: s.lastActiveAt,
                    createdAt: s.createdAt,
                  }
                })
              return JSON.stringify(items)
            }

            if (action === 'history') {
              if (!sessionId) return 'Error: sessionId is required for history.'
              const target = sessions[sessionId]
              if (!target) return `Not found: session "${sessionId}"`
              const max = Math.max(1, Math.min(limit || 20, 100))
              const history = (target.messages || []).slice(-max).map((m: any) => ({
                role: m.role,
                text: m.text,
                time: m.time,
                kind: m.kind || 'chat',
              }))
              return JSON.stringify({ sessionId: target.id, name: target.name, history })
            }

            if (action === 'status') {
              if (!sessionId) return 'Error: sessionId is required for status.'
              const target = sessions[sessionId]
              if (!target) return `Not found: session "${sessionId}"`
              const { getSessionRunState } = await import('./session-run-manager')
              const run = getSessionRunState(sessionId)
              return JSON.stringify({
                id: target.id,
                name: target.name,
                runningRunId: run.runningRunId || null,
                queuedCount: run.queueLength,
                heartbeatEnabled: target.heartbeatEnabled !== false,
                lastActiveAt: target.lastActiveAt,
                messageCount: (target.messages || []).length,
              })
            }

            if (action === 'stop') {
              if (!sessionId) return 'Error: sessionId is required for stop.'
              if (!sessions[sessionId]) return `Not found: session "${sessionId}"`
              const { cancelSessionRuns } = await import('./session-run-manager')
              const out = cancelSessionRuns(sessionId, 'Stopped by manage_sessions')
              return JSON.stringify({ sessionId, ...out })
            }

            if (action === 'send') {
              if (!sessionId) return 'Error: sessionId is required for send.'
              if (!message?.trim()) return 'Error: message is required for send.'
              if (!sessions[sessionId]) return `Not found: session "${sessionId}"`
              if (ctx?.sessionId && sessionId === ctx.sessionId) return 'Error: cannot send to the current session itself.'

              const sourceSession = ctx?.sessionId ? sessions[ctx.sessionId] : null
              const sourceLabel = sourceSession
                ? `${sourceSession.name} (${sourceSession.id})`
                : (ctx?.agentId ? `agent:${ctx.agentId}` : 'platform')
              const bridgedMessage = `[Session message from ${sourceLabel}]\n${message.trim()}`

              const { enqueueSessionRun } = await import('./session-run-manager')
              const mode = queueMode === 'steer' || queueMode === 'collect' || queueMode === 'followup'
                ? queueMode
                : 'followup'
              const run = enqueueSessionRun({
                sessionId,
                message: bridgedMessage,
                source: 'session-send',
                internal: false,
                mode,
              })

              if (waitForReply === false) {
                return JSON.stringify({
                  sessionId,
                  runId: run.runId,
                  status: 'queued',
                  mode,
                })
              }

              const timeoutMs = Math.max(5, Math.min(timeoutSec || 120, 900)) * 1000
              const result = await Promise.race([
                run.promise,
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error(`Timed out waiting for session reply after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs),
                ),
              ])
              return JSON.stringify({
                sessionId,
                runId: run.runId,
                status: result.error ? 'failed' : 'completed',
                reply: result.text || '',
                error: result.error || null,
              })
            }

            if (action === 'spawn') {
              if (!agentId) return 'Error: agentId is required for spawn.'
              const agents = loadAgents()
              const agent = agents[agentId]
              if (!agent) return `Not found: agent "${agentId}"`

              const id = crypto.randomBytes(4).toString('hex')
              const now = Date.now()
              const entry = {
                id,
                name: (name || `${agent.name} Session`).trim(),
                cwd,
                user: 'swarm',
                provider: agent.provider || 'claude-cli',
                model: agent.model || '',
                credentialId: agent.credentialId || null,
                apiEndpoint: agent.apiEndpoint || null,
                claudeSessionId: null,
                messages: [],
                createdAt: now,
                lastActiveAt: now,
                sessionType: 'orchestrated',
                agentId: agent.id,
                parentSessionId: ctx?.sessionId || null,
                tools: agent.tools || [],
                heartbeatEnabled: agent.heartbeatEnabled ?? null,
                heartbeatIntervalSec: agent.heartbeatIntervalSec ?? null,
              }
              sessions[id] = entry as any
              saveSessions(sessions)

              let runId: string | null = null
              if (message?.trim()) {
                const { enqueueSessionRun } = await import('./session-run-manager')
                const run = enqueueSessionRun({
                  sessionId: id,
                  message: message.trim(),
                  source: 'session-spawn',
                  internal: false,
                  mode: 'followup',
                })
                runId = run.runId
              }

              return JSON.stringify({
                sessionId: id,
                name: entry.name,
                agentId: agent.id,
                queuedRunId: runId,
              })
            }

            if (action === 'set_heartbeat') {
              const targetSessionId = sessionId || ctx?.sessionId || null
              if (!targetSessionId) return 'Error: sessionId is required when no current session context exists.'
              const target = sessions[targetSessionId]
              if (!target) return `Not found: session "${targetSessionId}"`
              if (typeof heartbeatEnabled !== 'boolean') return 'Error: heartbeatEnabled (boolean) is required for set_heartbeat.'

              target.heartbeatEnabled = heartbeatEnabled
              target.lastActiveAt = Date.now()

              let statusMessageAdded = false
              if (!heartbeatEnabled && finalStatus?.trim()) {
                if (!Array.isArray(target.messages)) target.messages = []
                target.messages.push({
                  role: 'assistant',
                  text: finalStatus.trim(),
                  time: Date.now(),
                  kind: 'heartbeat',
                })
                statusMessageAdded = true
              }

              saveSessions(sessions)
              return JSON.stringify({
                sessionId: targetSessionId,
                heartbeatEnabled: target.heartbeatEnabled !== false,
                statusMessageAdded,
              })
            }

            return 'Unknown action. Use list, history, status, send, spawn, stop, or set_heartbeat.'
          } catch (err: any) {
            return `Error: ${err.message || String(err)}`
          }
        },
        {
          name: 'sessions_tool',
          description: 'Session-to-session operations: list/status/history sessions, send messages to other sessions, spawn new agent sessions, stop active runs, and control per-session heartbeat.',
          schema: z.object({
            action: z.enum(['list', 'history', 'status', 'send', 'spawn', 'stop', 'set_heartbeat']).describe('Session action'),
            sessionId: z.string().optional().describe('Target session id (required for history/status/send/stop; optional for set_heartbeat when current session context exists)'),
            message: z.string().optional().describe('Message body (required for send, optional initial task for spawn)'),
            limit: z.number().optional().describe('Max items/messages for list/history'),
            agentId: z.string().optional().describe('Agent id to spawn (required for spawn)'),
            name: z.string().optional().describe('Optional session name for spawn'),
            waitForReply: z.boolean().optional().describe('For send: if false, queue and return immediately'),
            timeoutSec: z.number().optional().describe('For send with waitForReply=true, max wait time in seconds (default 120)'),
            queueMode: z.enum(['followup', 'steer', 'collect']).optional().describe('Queue mode for send'),
            heartbeatEnabled: z.boolean().optional().describe('For set_heartbeat: true to enable heartbeat, false to disable'),
            finalStatus: z.string().optional().describe('For set_heartbeat when disabling: optional final status update to append in the session'),
          }),
        },
      ),
    )
  }

  return {
    tools,
    cleanup: async () => {
      for (const fn of cleanupFns) {
        try { await fn() } catch { /* ignore */ }
      }
    },
  }
}
