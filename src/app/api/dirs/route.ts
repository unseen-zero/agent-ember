import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'

export async function GET(req: NextRequest) {
  const rawPath = req.nextUrl.searchParams.get('path')
  const targetDir = rawPath || path.join(os.homedir(), 'Dev')

  // Resolve ~ to home dir
  const resolved = targetDir.startsWith('~')
    ? path.join(os.homedir(), targetDir.slice(1))
    : path.resolve(targetDir)

  let dirs: Array<{ name: string; path: string }> = []
  try {
    dirs = fs.readdirSync(resolved)
      .filter(d => {
        if (d.startsWith('.')) return false
        try { return fs.statSync(path.join(resolved, d)).isDirectory() } catch { return false }
      })
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(d => ({ name: d, path: path.join(resolved, d) }))
  } catch {}

  const parentPath = resolved === '/' ? null : path.dirname(resolved)

  return NextResponse.json({ dirs, currentPath: resolved, parentPath })
}
