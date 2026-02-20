import Database from 'better-sqlite3'
import path from 'path'
import crypto from 'crypto'
import type { MemoryEntry } from '@/types'
import { getEmbedding, cosineSimilarity, serializeEmbedding, deserializeEmbedding } from './embeddings'

const DB_PATH = path.join(process.cwd(), 'data', 'memory.db')

// Simple cache for query embeddings to avoid blocking
const embeddingCache = new Map<string, number[]>()

function getEmbeddingSync(query: string): number[] | null {
  const cached = embeddingCache.get(query)
  if (cached) return cached
  // Kick off async computation for next time
  getEmbedding(query).then((emb) => {
    if (emb) embeddingCache.set(query, emb)
    // Evict old entries
    if (embeddingCache.size > 100) {
      const firstKey = embeddingCache.keys().next().value
      if (firstKey) embeddingCache.delete(firstKey)
    }
  }).catch(() => { /* ok */ })
  return null
}

let _db: ReturnType<typeof initDb> | null = null

function initDb() {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      agentId TEXT,
      sessionId TEXT,
      category TEXT NOT NULL DEFAULT 'note',
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      metadata TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )
  `)

  // Safe column migrations for older databases
  for (const col of [
    'agentId TEXT',
    'sessionId TEXT',
    'embedding BLOB',
  ]) {
    try { db.exec(`ALTER TABLE memories ADD COLUMN ${col}`) } catch { /* already exists */ }
  }

  // FTS5 virtual table for full-text search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      title, content, category,
      content='memories',
      content_rowid='rowid'
    )
  `)

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, content, category)
      VALUES (new.rowid, new.title, new.content, new.category);
    END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, category)
      VALUES ('delete', old.rowid, old.title, old.content, old.category);
    END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, category)
      VALUES ('delete', old.rowid, old.title, old.content, old.category);
      INSERT INTO memories_fts(rowid, title, content, category)
      VALUES (new.rowid, new.title, new.content, new.category);
    END
  `)

  // Seed platform knowledge for the default agent on fresh installs
  const memCount = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c
  if (memCount === 0) {
    const now = Date.now()
    const seeds: Array<{ category: string; title: string; content: string }> = [
      {
        category: 'platform',
        title: 'swarmclaw_task_queue',
        content: `SwarmClaw uses a single-file task queue. The background daemon picks up queued tasks on a 30-second interval and processes ONE task at a time globally. Tasks flow through statuses: backlog → queued → running → completed/failed. Only tasks with status "queued" are picked up. To assign work, create a task with manage_tasks (action: "create") setting status to "queued" and an agentId. The daemon will execute it automatically on the next heartbeat cycle.`,
      },
      {
        category: 'platform',
        title: 'swarmclaw_heartbeat_system',
        content: `The SwarmClaw daemon runs a 30-second heartbeat loop. Every 2 minutes it performs health checks and can send alerts via WhatsApp if a connector is configured. Health monitoring only runs when the daemon is in "ongoing" loop mode (continuous operation). The daemon also processes scheduled jobs (cron/interval/once) and queued tasks on each heartbeat tick. Daemon status is visible in the UI footer and via the /api/daemon endpoint.`,
      },
      {
        category: 'platform',
        title: 'swarmclaw_cli_delegation',
        content: `SwarmClaw supports delegating work to CLI tools: Claude Code CLI, OpenAI Codex CLI, and OpenCode CLI. Each spawns as a child process with streaming output. Claude CLI uses --print --output-format stream-json. The claude_code tool supports "resume" to continue a previous conversation by session ID. The dangerouslyAutoApprove setting (from Settings → General) controls whether CLI processes auto-approve tool use. CLI providers have auth preflight checks and timeout diagnostics.`,
      },
      {
        category: 'platform',
        title: 'swarmclaw_connectors',
        content: `Chat connectors bridge agents to messaging platforms: Discord (discord.js, bot token, channel filtering), Slack (@slack/bolt socket mode, dual tokens, channel filtering), Telegram (telegraf, bot token, chat filtering), and WhatsApp (@whiskeysockets/baileys, QR pairing, multi-file auth state). The connector manager routes inbound messages to agents via routeMessage(). The special NO_MESSAGE sentinel value means "don't send a reply" — use it when the agent processes something silently. Connectors support media handling (images, files) and the connector_message_tool lets agents send messages through connected platforms.`,
      },
      {
        category: 'platform',
        title: 'swarmclaw_memory_system',
        content: `Agent memory lives in a separate database (data/memory.db) from the main app DB. It uses hybrid search: FTS5 full-text search plus optional vector embeddings (cosine similarity, threshold 0.3). Memory operations: store (save knowledge with category/title/content), search (keyword + vector), get (by ID), delete. Memories can be scoped to an agentId and/or sessionId. Use the memory tool with action "store" to save important facts, and "search" to recall them later. Categories include: note, fact, context, platform, and any custom string.`,
      },
      {
        category: 'platform',
        title: 'swarmclaw_session_tools',
        content: `The sessions_tool enables inter-session communication and management. Actions: spawn (create a new agent session and optionally send an initial message), send (send a message to another session), stop (halt a running session), history (get message history), status (check session state). The session run queue supports followup (continue conversation), steer (redirect agent behavior), and collect (gather results) modes. Each session is tied to an agent and maintains its own message history and tool state.`,
      },
      {
        category: 'platform',
        title: 'swarmclaw_agent_orchestration',
        content: `Multi-agent orchestration uses LangGraph for structured workflows. An orchestrator agent can delegate to sub-agents automatically based on the task. Maximum 10 turns per orchestration run to prevent infinite loops. To create an orchestrator, toggle "Orchestrator" when creating/editing an agent and assign sub-agents. The orchestrator's system prompt guides how it routes tasks. Plain orchestration (orchestrator.ts) and LangGraph orchestration (orchestrator-lg.ts) are both available. Sub-agents execute independently and return results to the orchestrator.`,
      },
      {
        category: 'platform',
        title: 'swarmclaw_architecture',
        content: `SwarmClaw is built on Next.js 16 with React 19, TypeScript, Tailwind v4, and shadcn/ui. Data is stored in SQLite with WAL mode using a JSON-blob collections pattern (each table has id TEXT PRIMARY KEY, data TEXT NOT NULL). Real-time chat uses SSE (Server-Sent Events) streaming. State management uses Zustand stores. The app runs on port 3456 by default. Production builds use Next.js standalone output mode. Native dependency better-sqlite3 requires python3/make/g++ for compilation.`,
      },
      {
        category: 'platform',
        title: 'swarmclaw_security',
        content: `Authentication uses a single access key (generated on first run, stored in .env.local). All API requests require the key via X-Access-Key header or ?key= query param. Secrets (API keys, tokens) are encrypted with AES-256 using the CREDENTIAL_SECRET env var. Important: CLI providers (claude-cli, codex-cli, opencode-cli) have full shell access on the host machine — they can read, write, and execute anything the process user can. Never expose the dashboard to the public internet without a reverse proxy and TLS.`,
      },
      {
        category: 'platform',
        title: 'swarmclaw_new_user_onboarding',
        content: `When helping a new user get started with SwarmClaw: 1) Guide them to set up at least one provider (Settings → Providers) — Ollama for local models, CLI providers (Claude Code, Codex, OpenCode) for terminal-based coding agents, or add an API key for cloud providers like Anthropic, OpenAI, Google Gemini, DeepSeek, Groq, Together AI, Mistral, xAI, or Fireworks AI. 2) Show them how to create a custom agent (Agents tab → "+") with a name, provider, model, system prompt, and tools. 3) Demonstrate the Task Board for queuing work. 4) Explain Skills for reusable agent instructions. 5) Point out Connectors if they want chat platform integration. 6) Mention the encrypted Secrets vault for API keys. Start simple — one provider, one custom agent — then expand.`,
      },
    ]

    const seedStmt = db.prepare(`
      INSERT INTO memories (id, agentId, sessionId, category, title, content, metadata, embedding, createdAt, updatedAt)
      VALUES (?, 'default', NULL, ?, ?, ?, NULL, NULL, ?, ?)
    `)
    const seedAll = db.transaction(() => {
      for (const s of seeds) {
        const id = crypto.randomBytes(6).toString('hex')
        seedStmt.run(id, s.category, s.title, s.content, now, now)
      }
    })
    seedAll()

    // Backfill FTS for seeded rows (triggers only fire for new inserts via the trigger,
    // but since we're inside initDb the triggers are already created — rows are indexed automatically)
    console.log(`[memory-db] Seeded ${seeds.length} platform memories for default agent`)
  }

  const stmts = {
    insert: db.prepare(`
      INSERT INTO memories (id, agentId, sessionId, category, title, content, metadata, embedding, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    update: db.prepare(`
      UPDATE memories SET agentId=?, sessionId=?, category=?, title=?, content=?, metadata=?, embedding=?, updatedAt=?
      WHERE id=?
    `),
    delete: db.prepare(`DELETE FROM memories WHERE id=?`),
    getById: db.prepare(`SELECT * FROM memories WHERE id=?`),
    listAll: db.prepare(`SELECT * FROM memories ORDER BY updatedAt DESC LIMIT 200`),
    listByAgent: db.prepare(`SELECT * FROM memories WHERE agentId=? ORDER BY updatedAt DESC LIMIT 200`),
    search: db.prepare(`
      SELECT m.* FROM memories m
      INNER JOIN memories_fts f ON m.rowid = f.rowid
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT 100
    `),
    searchByAgent: db.prepare(`
      SELECT m.* FROM memories m
      INNER JOIN memories_fts f ON m.rowid = f.rowid
      WHERE memories_fts MATCH ? AND m.agentId = ?
      ORDER BY rank
      LIMIT 100
    `),
  }

  function rowToEntry(row: any): MemoryEntry {
    return {
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }
  }

  const getAllWithEmbeddings = db.prepare(
    `SELECT * FROM memories WHERE embedding IS NOT NULL`
  )
  const getAllWithEmbeddingsByAgent = db.prepare(
    `SELECT * FROM memories WHERE embedding IS NOT NULL AND agentId = ?`
  )

  return {
    add(data: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): MemoryEntry {
      const id = crypto.randomBytes(6).toString('hex')
      const now = Date.now()
      stmts.insert.run(
        id, data.agentId || null, data.sessionId || null,
        data.category, data.title, data.content,
        data.metadata ? JSON.stringify(data.metadata) : null,
        null, // embedding computed async
        now, now,
      )
      // Compute embedding in background (fire-and-forget)
      const text = `${data.title} ${data.content}`.slice(0, 4000)
      getEmbedding(text).then((emb) => {
        if (emb) {
          db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`).run(
            serializeEmbedding(emb), id,
          )
        }
      }).catch(() => { /* embedding not available, ok */ })
      return { ...data, id, createdAt: now, updatedAt: now }
    },

    update(id: string, updates: Partial<MemoryEntry>): MemoryEntry | null {
      const existing = stmts.getById.get(id) as any
      if (!existing) return null
      const merged = { ...rowToEntry(existing), ...updates }
      const now = Date.now()
      stmts.update.run(
        merged.agentId || null, merged.sessionId || null,
        merged.category, merged.title, merged.content,
        merged.metadata ? JSON.stringify(merged.metadata) : null,
        existing.embedding, // preserve existing embedding
        now, id,
      )
      // Re-compute embedding if content changed
      if (updates.title || updates.content) {
        const text = `${merged.title} ${merged.content}`.slice(0, 4000)
        getEmbedding(text).then((emb) => {
          if (emb) {
            db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`).run(
              serializeEmbedding(emb), id,
            )
          }
        }).catch(() => { /* ok */ })
      }
      return { ...merged, updatedAt: now }
    },

    delete(id: string) {
      stmts.delete.run(id)
    },

    get(id: string): MemoryEntry | null {
      const row = stmts.getById.get(id) as any
      if (!row) return null
      return rowToEntry(row)
    },

    search(query: string, agentId?: string): MemoryEntry[] {
      // FTS keyword search
      const ftsQuery = query.split(/\s+/).filter(Boolean).map((w) => `"${w}"`).join(' OR ')
      const ftsResults: MemoryEntry[] = ftsQuery
        ? (agentId
            ? stmts.searchByAgent.all(ftsQuery, agentId) as any[]
            : stmts.search.all(ftsQuery) as any[]
          ).map(rowToEntry)
        : []

      // Attempt vector search (synchronous — uses cached embedding if available)
      let vectorResults: MemoryEntry[] = []
      try {
        const queryEmbedding = getEmbeddingSync(query)
        if (queryEmbedding) {
          const rows = agentId
            ? getAllWithEmbeddingsByAgent.all(agentId) as any[]
            : getAllWithEmbeddings.all() as any[]

          const scored = rows
            .map((row) => {
              const emb = deserializeEmbedding(row.embedding)
              const score = cosineSimilarity(queryEmbedding, emb)
              return { row, score }
            })
            .filter((s) => s.score > 0.3) // relevance threshold
            .sort((a, b) => b.score - a.score)
            .slice(0, 20)

          vectorResults = scored.map((s) => rowToEntry(s.row))
        }
      } catch {
        // Vector search unavailable, use FTS only
      }

      // Merge: deduplicate by id, FTS results first then vector-only
      const seen = new Set<string>()
      const merged: MemoryEntry[] = []
      for (const entry of [...ftsResults, ...vectorResults]) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id)
          merged.push(entry)
        }
      }
      return merged.slice(0, 100)
    },

    list(agentId?: string): MemoryEntry[] {
      const rows = agentId
        ? stmts.listByAgent.all(agentId) as any[]
        : stmts.listAll.all() as any[]
      return rows.map(rowToEntry)
    },

    getByAgent(agentId: string): MemoryEntry[] {
      return (stmts.listByAgent.all(agentId) as any[]).map(rowToEntry)
    },
  }
}

export function getMemoryDb() {
  if (!_db) _db = initDb()
  return _db
}
