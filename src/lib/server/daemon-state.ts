import { loadQueue, loadSchedules } from './storage'
import { processNext } from './queue'
import { startScheduler, stopScheduler } from './scheduler'
import { sweepOrphanedBrowsers, getActiveBrowserCount } from './session-tools'
import { autoStartConnectors, stopAllConnectors } from './connectors/manager'

const QUEUE_CHECK_INTERVAL = 30_000 // 30 seconds
const BROWSER_SWEEP_INTERVAL = 60_000 // 60 seconds
const BROWSER_MAX_AGE = 10 * 60 * 1000 // 10 minutes idle = orphaned

// Store daemon state on globalThis to survive HMR reloads
const gk = '__swarmclaw_daemon__' as const
const ds: {
  queueIntervalId: ReturnType<typeof setInterval> | null
  browserSweepId: ReturnType<typeof setInterval> | null
  running: boolean
  lastProcessedAt: number | null
} = (globalThis as any)[gk] ?? ((globalThis as any)[gk] = {
  queueIntervalId: null,
  browserSweepId: null,
  running: false,
  lastProcessedAt: null,
})

export function startDaemon() {
  if (ds.running) return
  ds.running = true
  console.log('[daemon] Starting daemon (scheduler + queue processor)')

  startScheduler()
  startQueueProcessor()
  startBrowserSweep()

  // Auto-start enabled connectors
  autoStartConnectors().catch((err) => {
    console.error('[daemon] Error auto-starting connectors:', err.message)
  })
}

export function stopDaemon() {
  if (!ds.running) return
  ds.running = false
  console.log('[daemon] Stopping daemon')

  stopScheduler()
  stopQueueProcessor()
  stopBrowserSweep()
  stopAllConnectors().catch(() => {})
}

function startBrowserSweep() {
  if (ds.browserSweepId) return
  ds.browserSweepId = setInterval(() => {
    const count = getActiveBrowserCount()
    if (count > 0) {
      const cleaned = sweepOrphanedBrowsers(BROWSER_MAX_AGE)
      if (cleaned > 0) {
        console.log(`[daemon] Cleaned ${cleaned} orphaned browser(s), ${getActiveBrowserCount()} still active`)
      }
    }
  }, BROWSER_SWEEP_INTERVAL)
}

function stopBrowserSweep() {
  if (ds.browserSweepId) {
    clearInterval(ds.browserSweepId)
    ds.browserSweepId = null
  }
  // Kill all remaining browsers on shutdown
  sweepOrphanedBrowsers(0)
}

function startQueueProcessor() {
  if (ds.queueIntervalId) return
  ds.queueIntervalId = setInterval(async () => {
    const queue = loadQueue()
    if (queue.length > 0) {
      console.log(`[daemon] Processing ${queue.length} queued task(s)`)
      await processNext()
      ds.lastProcessedAt = Date.now()
    }
  }, QUEUE_CHECK_INTERVAL)
}

function stopQueueProcessor() {
  if (ds.queueIntervalId) {
    clearInterval(ds.queueIntervalId)
    ds.queueIntervalId = null
  }
}

export function getDaemonStatus() {
  const queue = loadQueue()
  const schedules = loadSchedules()

  // Find next scheduled task
  let nextScheduled: number | null = null
  for (const s of Object.values(schedules) as any[]) {
    if (s.status === 'active' && s.nextRunAt) {
      if (!nextScheduled || s.nextRunAt < nextScheduled) {
        nextScheduled = s.nextRunAt
      }
    }
  }

  return {
    running: ds.running,
    schedulerActive: ds.running,
    queueLength: queue.length,
    lastProcessed: ds.lastProcessedAt,
    nextScheduled,
  }
}

// Auto-start daemon on import (starts scheduler, queue processor, and enabled connectors)
startDaemon()
