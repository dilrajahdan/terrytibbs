import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

function cancelled(): Error { const error = new Error('Operation cancelled'); error.name = 'AbortError'; return error }

export interface AudioLease {
  /** Completion of an optional buzz scheduled as part of activation, independent of mute readiness. */
  activationCue?: Promise<void>
  play(path: string): Promise<void>
  buzz(): Promise<void>
  /** Restores other audio and leaves the helper ready for the next trigger. */
  stop(): Promise<void>
}

interface Timeouts { startupMs: number; activateMs: number; releaseMs: number; playMs: number; terminateMs: number; killMs: number }
interface LeaseRequest {
  signal: AbortSignal
  onFailure: (error: Error) => void
  onAbort: () => void
  stopped: boolean
  active: boolean
  acquired: Promise<AudioLease>
  released: Promise<void>
  finishRelease: () => void
  releaseWork?: Promise<void>
}

/** Keeps an inactive native tap warm, with exclusive, cancellable recording leases. */
export class WarmAudioService {
  readonly ready: Promise<void>
  readonly closed: Promise<void>
  private readonly child: ChildProcessWithoutNullStreams
  private readonly timeouts: Timeouts
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private closeResolve!: () => void
  private readySettled = false
  private stopping = false
  private ended = false
  private buffer = ''
  private sequence = 0
  private current: LeaseRequest | null = null
  private requests = new Set<LeaseRequest>()
  private acquireTail: Promise<void> = Promise.resolve()
  private transition: { expected: 'ready' | 'standby'; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null
  private playback: { owner: LeaseRequest; id: string; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null
  private startupTimer: NodeJS.Timeout
  private terminateTimer?: NodeJS.Timeout
  private killTimer?: NodeJS.Timeout
  private failure: Error | null = null

  constructor(executable: string, timeouts: Partial<Timeouts> = {}) {
    this.timeouts = { startupMs: 5_000, activateMs: 5_000, releaseMs: 5_000, playMs: 5_000, terminateMs: 500, killMs: 1_000, ...timeouts }
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    // Warming may fail before the user starts a recording. Its consumer can still await the rejection.
    void this.ready.catch(() => undefined)
    this.closed = new Promise(resolve => { this.closeResolve = resolve })
    this.child = spawn(executable, ['--standby'], { shell: false, stdio: 'pipe', windowsHide: true })
    this.startupTimer = setTimeout(() => this.failed(new Error('The audio helper could not get ready in time. Restart Terry and try again.')), this.timeouts.startupMs)
    this.startupTimer.unref()
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      if (this.stopping) return
      this.buffer += chunk
      if (this.buffer.length > 16_384) { this.failed(new Error('The audio helper returned an invalid response.')); return }
      let newline: number
      while (!this.stopping && (newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1)
        try { this.message(JSON.parse(line)) } catch { this.failed(new Error('The audio helper returned an invalid response.')) }
      }
    })
    this.child.stderr.resume()
    this.child.stdin.on('error', () => { if (!this.stopping) this.failed(new Error('The audio helper disconnected. Dictation was cancelled.')) })
    this.child.once('error', () => this.failed(new Error('The audio helper could not start. Restart Terry and try again.')))
    this.child.once('close', () => {
      this.ended = true
      clearTimeout(this.startupTimer); clearTimeout(this.terminateTimer); clearTimeout(this.killTimer)
      if (!this.stopping) this.failed(new Error('The audio helper stopped unexpectedly. Dictation was cancelled.'))
      this.closeResolve()
    })
  }

  get running(): boolean { return !this.stopping && !this.ended }

  /** Snapshot of all already-requested leases, including an aborted activation still restoring audio. */
  get idle(): Promise<void> { return this.acquireTail }

  private message(value: unknown): void {
    if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') {
      this.failed(new Error('The audio helper returned an invalid response.')); return
    }
    const event = value as { type: string; id?: string; ok?: boolean; message?: string }
    if (event.type === 'error') {
      this.failed(new Error(typeof event.message === 'string' ? event.message.slice(0, 400) : 'The audio helper failed. Dictation was cancelled.'))
    } else if (event.type === 'standby' && !this.readySettled) {
      this.readySettled = true; clearTimeout(this.startupTimer); this.readyResolve()
    } else if (event.type === 'ready' || event.type === 'standby') {
      const pending = this.transition
      if (!pending || pending.expected !== event.type) {
        this.failed(new Error('The audio helper changed state unexpectedly. Dictation was cancelled.')); return
      }
      this.transition = null; clearTimeout(pending.timer); pending.resolve()
    } else if (event.type === 'cue-complete' && this.playback && this.playback.id === event.id) {
      const pending = this.playback; this.playback = null; clearTimeout(pending.timer)
      if (event.ok === true) pending.resolve()
      else { const error = new Error('The activation sound could not be played. Check the selected sound in Settings.'); error.name = 'ActivationSoundError'; pending.reject(error) }
    }
  }

  private rejectPending(error: Error): void {
    if (!this.readySettled) { this.readySettled = true; this.readyReject(error) }
    const transition = this.transition; this.transition = null
    if (transition) { clearTimeout(transition.timer); transition.reject(error) }
    this.rejectPlayback(error)
  }

  private rejectPlayback(error: Error): void {
    const pending = this.playback; this.playback = null
    if (pending) { clearTimeout(pending.timer); pending.reject(error) }
  }

  private failed(error: Error): void {
    if (this.stopping) return
    this.failure = error
    const active = this.current
    // Stop first so a failure callback cannot accidentally acquire another lease on this helper.
    void this.stop()
    if (active && !active.signal.aborted) {
      try { active.onFailure(error) } catch { /* A consumer callback must not interrupt native teardown. */ }
    }
  }

  private send(command: object): void {
    if (!this.running || this.child.stdin.destroyed) throw this.failure ?? new Error('The audio helper is no longer available.')
    this.child.stdin.write(JSON.stringify(command) + '\n')
  }

  private changeState(command: object, expected: 'ready' | 'standby', timeout: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.transition) { reject(new Error('An audio transition is already in progress.')); return }
      const timer = setTimeout(() => this.failed(new Error(expected === 'ready'
        ? 'Other audio could not be muted in time. Dictation was cancelled.'
        : 'Other audio could not be restored in time. The audio helper was stopped.')), timeout)
      timer.unref()
      this.transition = { expected, resolve, reject, timer }
      try { this.send(command) } catch (error) { this.failed(error as Error) }
    })
  }

  activate(signal: AbortSignal, onFailure: (error: Error) => void, mute = true, cue?: 'buzz'): Promise<AudioLease> {
    let finishRelease!: () => void
    const released = new Promise<void>(resolve => { finishRelease = resolve })
    let rejectAbort!: (error: Error) => void
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
    const request: LeaseRequest = {
      signal, onFailure, stopped: false, active: false, released, finishRelease,
      acquired: Promise.resolve(null as unknown as AudioLease),
      onAbort: () => { rejectAbort(cancelled()); void this.release(request) }
    }
    this.requests.add(request)
    const preceding = this.acquireTail
    // Waiting for a lease does not block its owner's release operation.
    this.acquireTail = preceding.then(() => released)
    request.acquired = (async () => {
      await preceding
      if (request.stopped || signal.aborted) throw cancelled()
      await this.ready
      if (request.stopped || signal.aborted) throw cancelled()
      if (!this.running) throw this.failure ?? new Error('The audio helper is no longer available.')
      this.current = request
      // Register before writing: the native output callback can finish the short
      // buzz while Core Audio is still applying the mute transition.
      const activationCue = cue ? this.beginPlayback(request) : undefined
      await this.changeState({ action: 'activate', mute, ...(activationCue ? { cue, id: activationCue.id } : {}) }, 'ready', this.timeouts.activateMs)
      request.active = true
      if (request.stopped || signal.aborted) throw cancelled()
      return {
        ...(activationCue ? { activationCue: activationCue.completion } : {}),
        play: path => this.play(request, { path }),
        buzz: () => this.play(request, { cue: 'buzz' }),
        stop: () => this.release(request)
      }
    })()
    void request.acquired.catch(() => { void this.release(request) })
    signal.addEventListener('abort', request.onAbort, { once: true })
    const result = Promise.race([request.acquired, aborted])
    // Cancellation and warm-up can fail before the caller attaches its await handler.
    void result.catch(() => undefined)
    if (signal.aborted) request.onAbort()
    return result
  }

  private async play(owner: LeaseRequest, command: { path: string } | { cue: 'buzz' }): Promise<void> {
    if (owner.stopped || owner.signal.aborted) throw cancelled()
    if (!owner.active || this.current !== owner || !this.running) throw this.failure ?? new Error('The audio recording session is no longer active.')
    const pending = this.beginPlayback(owner)
    try { this.send({ action: 'play', ...command, id: pending.id }) } catch (error) { this.failed(error as Error) }
    return await pending.completion
  }

  private beginPlayback(owner: LeaseRequest): { id: string; completion: Promise<void> } {
    if (this.playback) throw new Error('An activation sound is already playing.')
    const id = String(++this.sequence)
    const completion = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.failed(new Error('The activation sound took too long. Dictation was cancelled and other audio restored.')), this.timeouts.playMs)
      timer.unref()
      this.playback = { owner, id, resolve, reject, timer }
    })
    // A combined activation may fail or be cancelled before its lease is returned.
    void completion.catch(() => undefined)
    return { id, completion }
  }

  private release(request: LeaseRequest): Promise<void> {
    if (request.releaseWork) return request.releaseWork
    request.stopped = true
    request.signal.removeEventListener('abort', request.onAbort)
    if (this.playback?.owner === request) this.rejectPlayback(cancelled())
    request.releaseWork = (async () => {
      try {
        await request.acquired.catch(() => undefined)
        if (request.active && this.running) await this.changeState({ action: 'release' }, 'standby', this.timeouts.releaseMs)
        if (!this.running) await this.closed
      } catch (error) {
        this.failed(error as Error)
        await this.closed
      } finally {
        request.active = false
        if (this.current === request) this.current = null
        this.requests.delete(request)
        request.finishRelease()
      }
    })()
    return request.releaseWork
  }

  /** Closes the process completely, releasing its native tap even if it is unresponsive. */
  stop(): Promise<void> {
    if (this.stopping) return this.closed
    this.stopping = true
    clearTimeout(this.startupTimer)
    this.rejectPending(this.failure ?? cancelled())
    for (const request of this.requests) void this.release(request)
    if (!this.ended) {
      this.child.stdin.end(JSON.stringify({ action: 'stop' }) + '\n')
      this.terminateTimer = setTimeout(() => { if (!this.ended) this.child.kill('SIGTERM') }, this.timeouts.terminateMs)
      this.killTimer = setTimeout(() => { if (!this.ended) this.child.kill('SIGKILL') }, this.timeouts.killMs)
      this.terminateTimer.unref(); this.killTimer.unref()
    }
    return this.closed
  }
}
