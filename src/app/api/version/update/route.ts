import { NextResponse } from 'next/server'
import { execSync } from 'child_process'

function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', cwd: process.cwd(), timeout: 60_000 }).trim()
}

export async function POST() {
  try {
    // Pull latest changes
    const pullOutput = run('git pull origin main')

    // Check if package-lock.json changed in the pull
    let installedDeps = false
    try {
      const diff = run('git diff HEAD~1 --name-only')
      if (diff.includes('package-lock.json') || diff.includes('package.json')) {
        run('npm install --omit=dev')
        installedDeps = true
      }
    } catch {
      // If diff fails (e.g. first commit), skip install check
    }

    const newSha = run('git rev-parse --short HEAD')

    return NextResponse.json({
      success: true,
      newSha,
      pullOutput,
      installedDeps,
      needsRestart: true,
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : 'Update failed' },
      { status: 500 }
    )
  }
}
