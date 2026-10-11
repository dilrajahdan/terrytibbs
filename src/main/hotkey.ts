import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { parseShortcut } from '../shared/shortcut'

export type HotkeyEvent = { type: 'down' | 'up' | 'cancel' | 'ready' | 'unavailable' | 'candidate'; message?: string; shortcut?: string }
export interface HotkeyMonitor { stop(): void; suspend(paused: boolean): Promise<void> }

const READY_TIMEOUT_MS = 4_000
const SUSPEND_TIMEOUT_MS = 1_500
const MAX_LINE_LENGTH = 4_096
const MAX_MESSAGE_LENGTH = 400

interface SuspendBatch {
  paused: boolean
  timer: ReturnType<typeof setTimeout>
  waiters: Array<{ resolve(): void; reject(error: Error): void }>
}

export function createHotkeyMonitor(helper: string, shortcut: string, onEvent: (event: HotkeyEvent) => void): HotkeyMonitor {
  const parsed = parseShortcut(shortcut)
  const child: ChildProcessWithoutNullStreams = spawn(helper, ['watch-hotkey', parsed.value], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  })
  let stopped = false
  let settled = false
  let ready = false
  let pausedForCapture = false
  let output = ''
  let errorOutput = ''
  let suspendInFlight: SuspendBatch | null = null
  const suspendQueue: SuspendBatch[] = []

  const emit = (event: HotkeyEvent) => {
    if (stopped) return
    try { onEvent(event) } catch { /* A consumer error must not orphan the helper. */ }
  }
  const message = (fallback: string) => errorOutput.trim().slice(0, MAX_MESSAGE_LENGTH) || fallback
  const settleBatch = (batch: SuspendBatch, error?: Error) => {
    clearTimeout(batch.timer)
    for (const waiter of batch.waiters) error ? waiter.reject(error) : waiter.resolve()
  }
  const settleSuspensions = (error?: Error) => {
    if (suspendInFlight) settleBatch(suspendInFlight, error)
    suspendInFlight = null
    for (const batch of suspendQueue.splice(0)) settleBatch(batch, error)
  }
  const finish = (reason: string, suspensionError?: Error) => {
    if (settled || stopped) return
    settled = true
    clearTimeout(readinessTimer)
    settleSuspensions(suspensionError)
    if (ready) emit({ type: 'cancel', message: reason })
    emit({ type: 'unavailable', message: message(reason) })
  }
  const terminate = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  const protocolFailure = (reason: string) => {
    const error = new Error(reason)
    finish(reason, error)
    terminate()
  }
  const pumpSuspensions = () => {
    if (!ready || stopped || settled || suspendInFlight || !suspendQueue.length) return
    const batch = suspendQueue.shift()!
    suspendInFlight = batch
    if (!child.stdin.writable) {
      finish('The shortcut helper input closed.')
      terminate()
      return
    }
    child.stdin.write(`${JSON.stringify({ suspend: batch.paused })}\n`, error => {
      if (!error || stopped || settled) return
      finish('The shortcut helper input closed.')
      terminate()
    })
  }
  const acknowledgeSuspension = (paused: boolean) => {
    const batch = suspendInFlight
    if (!batch || batch.paused !== paused) {
      protocolFailure('The shortcut helper acknowledged an unexpected suspension state.')
      return
    }
    suspendInFlight = null
    pausedForCapture = paused
    settleBatch(batch)
    pumpSuspensions()
  }
  const acceptLine = (line: string) => {
    if (!line) return
    if (line.length > MAX_LINE_LENGTH) { protocolFailure('The shortcut helper sent an oversized response.'); return }
    let value: unknown
    try { value = JSON.parse(line) } catch { protocolFailure('The shortcut helper sent an invalid response.'); return }
    if (!value || typeof value !== 'object') { protocolFailure('The shortcut helper sent an invalid response.'); return }
    const candidate = value as { type?: unknown; message?: unknown; paused?: unknown; shortcut?: unknown }
    if (candidate.type === 'suspended') {
      if (!ready || typeof candidate.paused !== 'boolean') {
        protocolFailure('The shortcut helper sent an invalid suspension acknowledgement.')
        return
      }
      acknowledgeSuspension(candidate.paused)
      return
    }
    if (candidate.type === 'candidate') {
      if (!ready || !pausedForCapture || typeof candidate.shortcut !== 'string') {
        protocolFailure('The shortcut helper reported a candidate outside recording.'); return
      }
      try {
        const shortcut = parseShortcut(candidate.shortcut)
        if (shortcut.value !== 'Fn' && !/^F([1-9]|1[0-9]|20)$/.test(shortcut.key ?? '')) throw new Error('Unsupported native candidate')
        emit({ type: 'candidate', shortcut: shortcut.value })
      } catch { protocolFailure('The shortcut helper reported an invalid shortcut.') }
      return
    }
    if (!['down', 'up', 'cancel', 'ready', 'unavailable'].includes(String(candidate.type))) {
      protocolFailure('The shortcut helper sent an unknown event.'); return
    }
    const event: HotkeyEvent = {
      type: candidate.type as HotkeyEvent['type'],
      ...(typeof candidate.message === 'string' ? { message: candidate.message.slice(0, MAX_MESSAGE_LENGTH) } : {})
    }
    if (event.type === 'ready') {
      if (ready) return
      ready = true
      clearTimeout(readinessTimer)
      pumpSuspensions()
    }
    if (!ready && event.type !== 'ready' && event.type !== 'unavailable') {
      protocolFailure('The shortcut helper reported input before it was ready.'); return
    }
    if (event.type === 'unavailable') {
      settled = true
      clearTimeout(readinessTimer)
      settleSuspensions()
    }
    emit(event)
    if (event.type === 'unavailable') terminate()
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    if (settled || stopped) return
    output += chunk
    if (output.length > MAX_LINE_LENGTH * 2) { protocolFailure('The shortcut helper sent an oversized response.'); return }
    let newline = output.indexOf('\n')
    while (newline >= 0 && !settled) {
      const line = output.slice(0, newline).replace(/\r$/, '')
      output = output.slice(newline + 1)
      acceptLine(line)
      newline = output.indexOf('\n')
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { errorOutput = (errorOutput + chunk).slice(-MAX_LINE_LENGTH) })
  // A helper can exit between the writable check and a suspend/stop write.
  child.stdin.on('error', () => {
    finish('The shortcut helper input closed.')
    terminate()
  })
  child.once('error', () => finish('The shortcut helper could not start.'))
  child.once('exit', (code, signal) => {
    if (stopped || settled) return
    const detail = signal ? `signal ${signal}` : `status ${code ?? 'unknown'}`
    finish(`The shortcut helper stopped (${detail}).`)
  })
  const readinessTimer = setTimeout(() => {
    protocolFailure('The shortcut helper did not become ready.')
  }, READY_TIMEOUT_MS)
  readinessTimer.unref()

  return {
    stop() {
      if (stopped) return
      stopped = true
      settled = true
      clearTimeout(readinessTimer)
      settleSuspensions()
      child.stdin.end()
      terminate()
    },
    suspend(paused: boolean): Promise<void> {
      if (stopped || settled) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const waiter = { resolve, reject }
        const queued = suspendQueue.at(-1)
        if (queued?.paused === paused) {
          queued.waiters.push(waiter)
          return
        }
        if (!suspendQueue.length && suspendInFlight?.paused === paused) {
          suspendInFlight.waiters.push(waiter)
          return
        }
        const batch = {} as SuspendBatch
        batch.paused = paused
        batch.waiters = [waiter]
        batch.timer = setTimeout(() => {
          protocolFailure('The shortcut helper did not confirm its suspension state.')
        }, SUSPEND_TIMEOUT_MS)
        batch.timer.unref()
        suspendQueue.push(batch)
        pumpSuspensions()
      })
    }
  }
}
