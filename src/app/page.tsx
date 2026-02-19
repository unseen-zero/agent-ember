'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { initAudioContext } from '@/lib/tts'
import { getStoredAccessKey, clearStoredAccessKey, api } from '@/lib/api-client'
import { AccessKeyGate } from '@/components/auth/access-key-gate'
import { UserPicker } from '@/components/auth/user-picker'
import { SetupWizard } from '@/components/auth/setup-wizard'
import { AppLayout } from '@/components/layout/app-layout'

export default function Home() {
  const currentUser = useAppStore((s) => s.currentUser)
  const setUser = useAppStore((s) => s.setUser)
  const hydrated = useAppStore((s) => s._hydrated)
  const hydrate = useAppStore((s) => s.hydrate)
  const loadNetworkInfo = useAppStore((s) => s.loadNetworkInfo)
  const loadSessions = useAppStore((s) => s.loadSessions)

  const [authChecked, setAuthChecked] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [setupDone, setSetupDone] = useState<boolean | null>(null)

  const checkAuth = useCallback(async () => {
    const key = getStoredAccessKey()
    if (!key) {
      setAuthChecked(true)
      setAuthenticated(false)
      return
    }

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      })
      if (res.ok) {
        setAuthenticated(true)
      } else {
        clearStoredAccessKey()
        setAuthenticated(false)
      }
    } catch {
      setAuthenticated(true)
    }
    setAuthChecked(true)
  }, [])

  // After auth, try to restore username from server settings
  const syncUserFromServer = useCallback(async () => {
    if (currentUser) return // already have a name locally
    try {
      const settings = await api<{ userName?: string }>('GET', '/settings')
      if (settings.userName) {
        setUser(settings.userName)
      }
    } catch { /* ignore */ }
  }, [currentUser, setUser])

  useEffect(() => {
    hydrate()
  }, [])

  useEffect(() => {
    if (hydrated) checkAuth()
  }, [hydrated, checkAuth])

  useEffect(() => {
    if (!authenticated) return
    syncUserFromServer()
    loadNetworkInfo()
    loadSessions()
    const interval = setInterval(loadSessions, 5000)
    return () => clearInterval(interval)
  }, [authenticated])

  // Check if first-run setup is needed
  useEffect(() => {
    if (!authenticated || !currentUser) return
    let cancelled = false
    ;(async () => {
      try {
        const [settings, creds] = await Promise.all([
          api<{ setupCompleted?: boolean }>('GET', '/settings'),
          api<Record<string, unknown>>('GET', '/credentials'),
        ])
        if (cancelled) return
        const hasCreds = Object.keys(creds).length > 0
        setSetupDone(settings.setupCompleted === true || hasCreds)
      } catch {
        if (!cancelled) setSetupDone(true) // on error, skip wizard
      }
    })()
    return () => { cancelled = true }
  }, [authenticated, currentUser])

  useEffect(() => {
    const handler = () => {
      initAudioContext()
      document.removeEventListener('click', handler)
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  useEffect(() => {
    const handler = () => {
      setAuthenticated(false)
      setAuthChecked(true)
    }
    window.addEventListener('sc_auth_required', handler)
    return () => window.removeEventListener('sc_auth_required', handler)
  }, [])

  if (!hydrated || !authChecked) return null
  if (!authenticated) return <AccessKeyGate onAuthenticated={() => setAuthenticated(true)} />
  if (!currentUser) return <UserPicker />
  if (setupDone === null) return null
  if (!setupDone) return <SetupWizard onComplete={() => setSetupDone(true)} />
  return <AppLayout />
}
