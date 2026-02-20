#!/usr/bin/env -S node --experimental-strip-types

import { Command } from 'commander'
import { pathToFileURL } from 'node:url'

interface CliContext {
  baseUrl: string
  accessKey: string
  rawOutput: boolean
}

const DEFAULT_BASE_URL =
  process.env.SWARMCLAW_URL
  || process.env.SWARMCLAW_BASE_URL
  || 'http://localhost:3456'

const DEFAULT_ACCESS_KEY = process.env.SWARMCLAW_ACCESS_KEY || ''

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim()
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, '')
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object response`)
  }
  return value as Record<string, unknown>
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))
}

function parseMetadata(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid --metadata JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--metadata must be a JSON object')
  }

  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    out[key] = String(value)
  }
  return out
}

function parseTimestamp(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10)

  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid timestamp for --run-at: ${raw}`)
  }
  return ms
}

function collectValues(value: string, previous: string[]): string[] {
  previous.push(value)
  return previous
}

function contextFromCommand(command: Command): CliContext {
  const opts = command.optsWithGlobals<{
    url?: string
    key?: string
    raw?: boolean
  }>()

  return {
    baseUrl: normalizeBaseUrl(opts.url || DEFAULT_BASE_URL),
    accessKey: (opts.key || DEFAULT_ACCESS_KEY).trim(),
    rawOutput: Boolean(opts.raw),
  }
}

function buildApiUrl(ctx: CliContext, routePath: string, query?: URLSearchParams): URL {
  const apiBase = ctx.baseUrl.endsWith('/api') ? ctx.baseUrl : `${ctx.baseUrl}/api`
  const normalizedPath = routePath.startsWith('/') ? routePath : `/${routePath}`
  const url = new URL(`${apiBase}${normalizedPath}`)
  if (query) {
    query.forEach((value, key) => {
      url.searchParams.set(key, value)
    })
  }
  return url
}

async function apiRequest<T = unknown>(
  ctx: CliContext,
  method: string,
  routePath: string,
  body?: unknown,
  query?: URLSearchParams,
): Promise<T> {
  const url = buildApiUrl(ctx, routePath, query)
  const headers: Record<string, string> = {}

  if (ctx.accessKey) headers['X-Access-Key'] = ctx.accessKey
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  let responseBody: unknown = null

  if (contentType.includes('application/json')) {
    responseBody = await response.json().catch(() => null)
  } else {
    const text = await response.text().catch(() => '')
    responseBody = text.length > 0 ? text : null
  }

  if (!response.ok) {
    const detail = typeof responseBody === 'string'
      ? responseBody
      : JSON.stringify(responseBody)
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${detail}`)
  }

  return responseBody as T
}

function printResult(value: unknown, rawOutput: boolean): void {
  if (value === undefined || value === null) {
    console.log('null')
    return
  }

  if (typeof value === 'string') {
    console.log(value)
    return
  }

  if (rawOutput) {
    process.stdout.write(`${JSON.stringify(value)}\n`)
    return
  }

  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function resolveByIdFromCollection(
  ctx: CliContext,
  routePath: string,
  id: string,
): Promise<unknown> {
  const collection = parseObject(await apiRequest(ctx, 'GET', routePath), routePath)
  if (!(id in collection)) {
    throw new Error(`Not found: ${routePath} id=${id}`)
  }
  return collection[id]
}

async function runWithHandler(command: Command, task: (ctx: CliContext) => Promise<unknown>): Promise<void> {
  try {
    const ctx = contextFromCommand(command)
    const result = await task(ctx)
    printResult(result, ctx.rawOutput)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(msg)
    process.exitCode = 1
  }
}

export function buildProgram(): Command {
  const program = new Command()

  program
    .name('swarmclaw')
    .description('SwarmClaw CLI')
    .option('-u, --url <url>', 'SwarmClaw base URL', DEFAULT_BASE_URL)
    .option('-k, --key <key>', 'SwarmClaw access key', DEFAULT_ACCESS_KEY)
    .option('--raw', 'Print compact JSON output')
    .showHelpAfterError()

  const agents = program.command('agents').description('Manage agents')

  agents
    .command('list')
    .description('List agents')
    .action(async function () {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', '/agents'))
    })

  agents
    .command('get')
    .description('Get agent by id')
    .argument('<id>', 'Agent id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => resolveByIdFromCollection(ctx, '/agents', id))
    })

  const tasks = program.command('tasks').description('Manage tasks')

  tasks
    .command('list')
    .description('List tasks')
    .action(async function () {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', '/tasks'))
    })

  tasks
    .command('get')
    .description('Get task by id')
    .argument('<id>', 'Task id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', `/tasks/${encodeURIComponent(id)}`))
    })

  tasks
    .command('create')
    .description('Create task')
    .requiredOption('--title <title>', 'Task title')
    .option('--description <description>', 'Task description', '')
    .option('--agent-id <agentId>', 'Agent id')
    .option('--status <status>', 'Task status', 'backlog')
    .action(async function (opts: { title: string; description: string; agentId?: string; status: string }) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'POST', '/tasks', compactObject({
        title: opts.title,
        description: opts.description,
        agentId: opts.agentId,
        status: opts.status,
      })))
    })

  const schedules = program.command('schedules').description('Manage schedules')

  schedules
    .command('list')
    .description('List schedules')
    .action(async function () {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', '/schedules'))
    })

  schedules
    .command('get')
    .description('Get schedule by id')
    .argument('<id>', 'Schedule id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => resolveByIdFromCollection(ctx, '/schedules', id))
    })

  schedules
    .command('create')
    .description('Create schedule')
    .requiredOption('--name <name>', 'Schedule name')
    .requiredOption('--agent-id <agentId>', 'Agent id')
    .requiredOption('--task-prompt <taskPrompt>', 'Task prompt for the scheduled run')
    .option('--schedule-type <scheduleType>', 'cron | interval | once', 'cron')
    .option('--cron <cron>', 'Cron expression')
    .option('--interval-ms <intervalMs>', 'Interval in milliseconds')
    .option('--run-at <runAt>', 'Timestamp (ms) or ISO time for once schedules')
    .option('--status <status>', 'Schedule status', 'active')
    .action(async function (opts: {
      name: string
      agentId: string
      taskPrompt: string
      scheduleType: string
      cron?: string
      intervalMs?: string
      runAt?: string
      status: string
    }) {
      const intervalMs = opts.intervalMs ? Number.parseInt(opts.intervalMs, 10) : undefined
      if (opts.intervalMs && (!Number.isFinite(intervalMs) || intervalMs <= 0)) {
        throw new Error(`Invalid --interval-ms value: ${opts.intervalMs}`)
      }

      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'POST', '/schedules', compactObject({
        name: opts.name,
        agentId: opts.agentId,
        taskPrompt: opts.taskPrompt,
        scheduleType: opts.scheduleType,
        cron: opts.cron,
        intervalMs,
        runAt: parseTimestamp(opts.runAt),
        status: opts.status,
      })))
    })

  const sessions = program.command('sessions').description('Manage sessions')

  sessions
    .command('list')
    .description('List sessions')
    .action(async function () {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', '/sessions'))
    })

  sessions
    .command('history')
    .description('Get session message history')
    .argument('<id>', 'Session id')
    .action(async function (id: string) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', `/sessions/${encodeURIComponent(id)}/messages`))
    })

  const memory = program.command('memory').description('Manage memory')

  memory
    .command('search')
    .description('Search memory')
    .requiredOption('-q, --q <query>', 'Search query')
    .option('--agent-id <agentId>', 'Filter by agent id')
    .action(async function (opts: { q: string; agentId?: string }) {
      await runWithHandler(this as Command, (ctx) => {
        const params = new URLSearchParams()
        params.set('q', opts.q)
        if (opts.agentId) params.set('agentId', opts.agentId)
        return apiRequest(ctx, 'GET', '/memory', undefined, params)
      })
    })

  memory
    .command('store')
    .description('Store memory')
    .requiredOption('--title <title>', 'Memory title')
    .requiredOption('--content <content>', 'Memory content')
    .option('--category <category>', 'Memory category', 'note')
    .option('--agent-id <agentId>', 'Associated agent id')
    .option('--session-id <sessionId>', 'Associated session id')
    .option('--metadata <json>', 'Metadata JSON object, ex: {"priority":"high"}')
    .action(async function (opts: {
      title: string
      content: string
      category: string
      agentId?: string
      sessionId?: string
      metadata?: string
    }) {
      const metadata = parseMetadata(opts.metadata)
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'POST', '/memory', compactObject({
        title: opts.title,
        content: opts.content,
        category: opts.category,
        agentId: opts.agentId,
        sessionId: opts.sessionId,
        metadata,
      })))
    })

  const connectors = program.command('connectors').description('Manage connectors')

  connectors
    .command('list')
    .description('List connectors')
    .action(async function () {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', '/connectors'))
    })

  const webhooks = program.command('webhooks').description('Manage webhooks')

  webhooks
    .command('list')
    .description('List webhooks')
    .action(async function () {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'GET', '/webhooks'))
    })

  webhooks
    .command('create')
    .description('Create webhook')
    .option('--name <name>', 'Webhook name', 'Unnamed Webhook')
    .option('--source <source>', 'Webhook source', 'custom')
    .option('--event <event>', 'Webhook event filter (repeatable)', collectValues, [])
    .option('--agent-id <agentId>', 'Agent id')
    .option('--secret <secret>', 'Webhook secret')
    .option('--disabled', 'Create webhook in disabled state')
    .action(async function (opts: {
      name: string
      source: string
      event: string[]
      agentId?: string
      secret?: string
      disabled?: boolean
    }) {
      await runWithHandler(this as Command, (ctx) => apiRequest(ctx, 'POST', '/webhooks', compactObject({
        name: opts.name,
        source: opts.source,
        events: opts.event,
        agentId: opts.agentId,
        secret: opts.secret,
        isEnabled: opts.disabled ? false : true,
      })))
    })

  return program
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const program = buildProgram()
  try {
    await program.parseAsync(['node', 'swarmclaw', ...argv])
    return process.exitCode ?? 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(msg)
    return 1
  }
}

async function main(): Promise<void> {
  const code = await runCli(process.argv.slice(2))
  if (code !== 0) process.exitCode = code
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  void main()
}
