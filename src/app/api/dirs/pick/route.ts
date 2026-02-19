import { NextRequest, NextResponse } from 'next/server'
import { execSync } from 'child_process'
import path from 'path'
import os from 'os'

function pickMacOS(mode: 'file' | 'folder'): string | null {
  const script = mode === 'folder'
    ? `osascript -e 'POSIX path of (choose folder with prompt "Select a directory")'`
    : `osascript -e 'POSIX path of (choose file with prompt "Select a file")'`
  try {
    return execSync(script, { timeout: 60000, encoding: 'utf-8' }).trim().replace(/\/$/, '')
  } catch {
    return null
  }
}

function pickLinux(mode: 'file' | 'folder'): string | null {
  // Try zenity first (GTK), then kdialog (KDE)
  const zenityFlag = mode === 'folder' ? '--file-selection --directory' : '--file-selection'
  const kdialogFlag = mode === 'folder' ? '--getexistingdirectory ~' : '--getopenfilename ~'
  for (const cmd of [
    `zenity ${zenityFlag} --title="Select a ${mode}"`,
    `kdialog ${kdialogFlag}`,
  ]) {
    try {
      return execSync(cmd, { timeout: 60000, encoding: 'utf-8' }).trim()
    } catch { /* try next */ }
  }
  return null
}

function pickWindows(mode: 'file' | 'folder'): string | null {
  if (mode === 'folder') {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog() -eq 'OK'){$d.SelectedPath}`
    try {
      return execSync(`powershell -NoProfile -Command "${ps}"`, { timeout: 60000, encoding: 'utf-8' }).trim() || null
    } catch { return null }
  }
  const ps = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; if($d.ShowDialog() -eq 'OK'){$d.FileName}`
  try {
    return execSync(`powershell -NoProfile -Command "${ps}"`, { timeout: 60000, encoding: 'utf-8' }).trim() || null
  } catch { return null }
}

export async function POST(req: NextRequest) {
  const { mode = 'folder' } = (await req.json().catch(() => ({}))) as { mode?: 'file' | 'folder' }
  const platform = os.platform()

  let picked: string | null = null
  if (platform === 'darwin') picked = pickMacOS(mode)
  else if (platform === 'win32') picked = pickWindows(mode)
  else picked = pickLinux(mode)

  if (!picked) return NextResponse.json({ directory: null, file: null })

  const directory = mode === 'folder' ? picked : path.dirname(picked)
  const file = mode === 'file' ? picked : null

  return NextResponse.json({ directory, file })
}
