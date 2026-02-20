import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { loadTasks, saveTasks } from '@/lib/server/storage'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const includeArchived = searchParams.get('includeArchived') === 'true'
  const allTasks = loadTasks()

  if (includeArchived) {
    return NextResponse.json(allTasks)
  }

  // Exclude archived tasks by default
  const filtered: Record<string, typeof allTasks[string]> = {}
  for (const [id, task] of Object.entries(allTasks)) {
    if (task.status !== 'archived') {
      filtered[id] = task
    }
  }
  return NextResponse.json(filtered)
}

export async function POST(req: Request) {
  const body = await req.json()
  const id = crypto.randomBytes(4).toString('hex')
  const now = Date.now()
  const tasks = loadTasks()
  tasks[id] = {
    id,
    title: body.title || 'Untitled Task',
    description: body.description || '',
    status: body.status || 'backlog',
    agentId: body.agentId || '',
    sessionId: null,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
  }
  saveTasks(tasks)
  return NextResponse.json(tasks[id])
}
