import { NextResponse } from 'next/server'
import { execSync } from 'child_process'

let cachedRemote: { sha: string; behindBy: number; checkedAt: number } | null = null
const CACHE_TTL = 60_000 // 60s

function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', cwd: process.cwd(), timeout: 15_000 }).trim()
}

export async function GET() {
  try {
    const localSha = run('git rev-parse --short HEAD')

    let remoteSha = cachedRemote?.sha ?? localSha
    let behindBy = cachedRemote?.behindBy ?? 0

    if (!cachedRemote || Date.now() - cachedRemote.checkedAt > CACHE_TTL) {
      try {
        run('git fetch origin main --quiet')
        behindBy = parseInt(run('git rev-list HEAD..origin/main --count'), 10) || 0
        remoteSha = behindBy > 0
          ? run('git rev-parse --short origin/main')
          : localSha
        cachedRemote = { sha: remoteSha, behindBy, checkedAt: Date.now() }
      } catch {
        // fetch failed (no network, no remote, etc.) — use stale cache or defaults
      }
    }

    return NextResponse.json({
      localSha,
      remoteSha,
      updateAvailable: behindBy > 0,
      behindBy,
    })
  } catch {
    return NextResponse.json({ error: 'Not a git repository' }, { status: 500 })
  }
}
