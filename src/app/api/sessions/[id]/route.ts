import { NextResponse } from 'next/server'
import { loadSessions, saveSessions, active } from '@/lib/server/storage'
import { normalizeProviderEndpoint } from '@/lib/openclaw-endpoint'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const updates = await req.json()
  const sessions = loadSessions()
  if (!sessions[id]) return new NextResponse(null, { status: 404 })
  if (updates.name !== undefined) sessions[id].name = updates.name
  if (updates.cwd !== undefined) sessions[id].cwd = updates.cwd
  if (updates.provider !== undefined) sessions[id].provider = updates.provider
  if (updates.model !== undefined) sessions[id].model = updates.model
  if (updates.credentialId !== undefined) sessions[id].credentialId = updates.credentialId
  if (updates.apiEndpoint !== undefined) {
    sessions[id].apiEndpoint = normalizeProviderEndpoint(
      updates.provider || sessions[id].provider,
      updates.apiEndpoint,
    )
  }
  if (updates.agentId !== undefined) sessions[id].agentId = updates.agentId
  if (updates.tools !== undefined) sessions[id].tools = updates.tools
  if (updates.heartbeatEnabled !== undefined) sessions[id].heartbeatEnabled = updates.heartbeatEnabled
  if (updates.heartbeatIntervalSec !== undefined) sessions[id].heartbeatIntervalSec = updates.heartbeatIntervalSec
  saveSessions(sessions)
  return NextResponse.json(sessions[id])
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessions = loadSessions()
  if (sessions[id]?.name === '__main__') {
    return new NextResponse('Cannot delete main chat session', { status: 403 })
  }
  if (active.has(id)) {
    try { active.get(id).kill() } catch {}
    active.delete(id)
  }
  delete sessions[id]
  saveSessions(sessions)
  return new NextResponse('OK')
}
