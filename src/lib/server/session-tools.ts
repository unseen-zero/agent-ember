import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execSync, execFile } from 'child_process'
import * as cheerio from 'cheerio'
import { getMemoryDb } from './memory-db'
import { loadRuntimeSettings } from './runtime-settings'
import {
  loadAgents, saveAgents,
  loadTasks, saveTasks,
  loadSchedules, saveSchedules,
  loadSkills, saveSkills,
  loadConnectors, saveConnectors,
  loadSessions,
  UPLOAD_DIR,
} from './storage'

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
        async ({ command }) => {
          try {
            const output = execSync(command, {
              cwd,
              timeout: commandTimeoutMs,
              maxBuffer: MAX_OUTPUT * 2,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
            })
            return truncate(output || '(no output)', MAX_OUTPUT)
          } catch (err: any) {
            const stderr = err.stderr ? String(err.stderr) : ''
            const stdout = err.stdout ? String(err.stdout) : ''
            return truncate(`Exit code: ${err.status || 1}\n${stderr || stdout || err.message}`, MAX_OUTPUT)
          }
        },
        {
          name: 'execute_command',
          description: 'Execute a shell command in the session working directory. Returns stdout/stderr.',
          schema: z.object({
            command: z.string().describe('The shell command to execute'),
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
            // Clear these so delegation can run as an independent subprocess.
            delete env.CLAUDECODE
            delete env.CLAUDE_CODE_SESSION
            delete env.CLAUDE_SESSION_ID

            return new Promise<string>((resolve) => {
              const child = execFile(
                'claude',
                ['-p', task, '--output-format', 'text'],
                { cwd, timeout: claudeTimeoutMs, maxBuffer: MAX_OUTPUT * 2, env, encoding: 'utf-8' },
                (err, stdout, stderr) => {
                  if (err && !stdout) {
                    resolve(truncate(`Error: ${stderr || err.message}`, MAX_OUTPUT))
                  } else {
                    resolve(truncate(stdout || stderr || '(no output)', MAX_OUTPUT))
                  }
                },
              )
              // Kill on timeout safety net
              setTimeout(() => {
                try { child.kill('SIGTERM') } catch { /* ignore */ }
              }, claudeTimeoutMs + 5000)
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
        async ({ action, key, value, category, query }) => {
          try {
            if (action === 'store') {
              const entry = memDb.add({
                agentId: ctx?.agentId || null,
                sessionId: ctx?.sessionId || null,
                category: category || 'note',
                title: key,
                content: value || '',
              })
              return `Stored memory "${key}" (id: ${entry.id})`
            }
            if (action === 'search') {
              const results = memDb.search(query || key, ctx?.agentId || undefined)
              if (!results.length) return 'No memories found.'
              return results.map((m) => `[${m.id}] ${m.title}: ${m.content}`).join('\n')
            }
            if (action === 'list') {
              const results = memDb.list(ctx?.agentId || undefined)
              if (!results.length) return 'No memories stored yet.'
              return results.map((m) => `[${m.id}] ${m.category}/${m.title}: ${m.content}`).join('\n')
            }
            if (action === 'delete') {
              memDb.delete(key)
              return `Deleted memory "${key}"`
            }
            return `Unknown action "${action}". Use: store, search, list, or delete.`
          } catch (err: any) {
            return `Error: ${err.message}`
          }
        },
        {
          name: 'memory_tool',
          description: 'Store and retrieve long-term memories that persist across sessions. Use "store" to save knowledge, "search" to find relevant memories, "list" to see all memories, or "delete" to remove one.',
          schema: z.object({
            action: z.enum(['store', 'search', 'list', 'delete']).describe('The action to perform'),
            key: z.string().describe('For store: the memory title. For search: search query. For delete: the memory ID.'),
            value: z.string().optional().describe('The memory content (for store action)'),
            category: z.string().optional().describe('Category like "note", "fact", "preference" (for store action, defaults to "note")'),
            query: z.string().optional().describe('Search query (alternative to key for search action)'),
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
    manage_sessions: { toolId: 'manage_sessions', label: 'sessions', load: loadSessions, save: () => {}, readOnly: true },
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
          try {
            if (action === 'list') {
              return JSON.stringify(Object.values(res.load()))
            }
            if (action === 'get') {
              if (!id) return 'Error: "id" is required for get action.'
              const all = res.load()
              return all[id] ? JSON.stringify(all[id]) : `Not found: ${res.label} "${id}"`
            }
            if (res.readOnly) return `Cannot ${action} ${res.label} via this tool (read-only).`
            if (action === 'create') {
              const all = res.load()
              const newId = crypto.randomBytes(4).toString('hex')
              const raw = data ? JSON.parse(data) : {}
              const defaults = RESOURCE_DEFAULTS[toolKey]
              const parsed = defaults ? defaults(raw) : raw
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
              all[newId] = entry
              res.save(all)
              return JSON.stringify(entry)
            }
            if (action === 'update') {
              if (!id) return 'Error: "id" is required for update action.'
              const all = res.load()
              if (!all[id]) return `Not found: ${res.label} "${id}"`
              const parsed = data ? JSON.parse(data) : {}
              // Enforce assignment scope for tasks and schedules
              if (assignScope === 'self' && (toolKey === 'manage_tasks' || toolKey === 'manage_schedules')) {
                if (parsed.agentId && parsed.agentId !== ctx?.agentId) {
                  return `Error: You can only assign ${res.label} to yourself ("${ctx?.agentId}"). To assign to other agents, ask a user to enable "Assign to Other Agents" in your agent settings.`
                }
              }
              all[id] = { ...all[id], ...parsed, updatedAt: Date.now() }
              res.save(all)
              return JSON.stringify(all[id])
            }
            if (action === 'delete') {
              if (!id) return 'Error: "id" is required for delete action.'
              const all = res.load()
              if (!all[id]) return `Not found: ${res.label} "${id}"`
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

  return {
    tools,
    cleanup: async () => {
      for (const fn of cleanupFns) {
        try { await fn() } catch { /* ignore */ }
      }
    },
  }
}
