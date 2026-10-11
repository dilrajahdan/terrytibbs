import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

function cancelled(): Error { const error = new Error('Operation cancelled'); error.name = 'AbortError'; return error }

/** Owns one temporary native mute tap. Closing its process releases the tap. */
export class BackgroundAudioSession {
  readonly ready: Promise<void>
  readonly closed: Promise<void>
  private readonly child: ChildProcessWithoutNullStreams
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private closeResolve!: () => void
  private readySettled = false
  private stopping = false
  private ended = false
  private buffer = ''
  private sequence = 0
  private playPending: { id: string; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null
  private readyTimer: NodeJS.Timeout
  private stopTimer?: NodeJS.Timeout
  private killTimer?: NodeJS.Timeout
  private readonly onAbort: () => void

  constructor(executable: string, private readonly signal: AbortSignal, private readonly onFailure: (error: Error) => void, startupMs = 3_000) {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    this.closed = new Promise(resolve => { this.closeResolve = resolve })
    this.child = spawn(executable, [], { shell: false, stdio: 'pipe', windowsHide: true })
    this.onAbort = () => { void this.stop() }
    this.readyTimer = setTimeout(() => this.failed(new Error('Other audio could not be muted in time. Try again, or turn off Mute other audio in Settings.')), startupMs)
    this.readyTimer.unref()
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      if (this.buffer.length > 16_384) { this.failed(new Error('The background audio helper returned an invalid response.')); return }
      let newline: number
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1)
        try { this.message(JSON.parse(line)) } catch { this.failed(new Error('The background audio helper returned an invalid response.')) }
      }
    })
    // Drain diagnostics without recording other applications' audio or user paths.
    this.child.stderr.resume()
    this.child.stdin.on('error', () => { if (!this.stopping) this.failed(new Error('The background audio helper disconnected.')) })
    this.child.once('error', () => this.failed(new Error('The background audio helper could not start. Restart Terry or turn off Mute other audio in Settings.')))
    this.child.once('close', () => {
      this.ended = true
      clearTimeout(this.readyTimer); clearTimeout(this.stopTimer); clearTimeout(this.killTimer)
      this.signal.removeEventListener('abort', this.onAbort)
      const error = this.signal.aborted || this.stopping ? cancelled() : new Error('Background audio muting stopped unexpectedly. Dictation was cancelled.')
      if (!this.readySettled) { this.readySettled = true; this.readyReject(error) }
      this.rejectPlayback(error)
      if (!this.stopping) this.onFailure(error)
      this.closeResolve()
    })
    this.signal.addEventListener('abort', this.onAbort, { once: true })
    if (signal.aborted) this.onAbort()
  }

  private message(value: unknown): void {
    if (this.stopping || !value || typeof value !== 'object') return
    const event = value as { type?: string; id?: string; ok?: boolean; message?: string }
    if (event.type === 'ready' && !this.readySettled) {
      this.readySettled = true; clearTimeout(this.readyTimer); this.readyResolve()
    } else if (event.type === 'cue-complete' && this.playPending && this.playPending.id === event.id) {
      const pending = this.playPending; this.playPending = null; clearTimeout(pending.timer)
      if (event.ok === true) pending.resolve()
      else { const error = new Error('The activation sound could not be played. Check the selected clip in Settings.'); error.name = 'ActivationSoundError'; pending.reject(error) }
    } else if (event.type === 'error') {
      this.failed(new Error(typeof event.message === 'string' ? event.message.slice(0, 400) : 'Other audio could not be muted.'))
    }
  }

  private rejectPlayback(error: Error): void {
    const pending = this.playPending
    this.playPending = null
    if (pending) { clearTimeout(pending.timer); pending.reject(error) }
  }

  private failed(error: Error): void {
    if (this.stopping) return
    if (!this.readySettled) { this.readySettled = true; this.readyReject(error) }
    this.rejectPlayback(error)
    this.onFailure(error)
    void this.stop()
  }

  async play(path: string): Promise<void> {
    await this.ready
    this.signal.throwIfAborted()
    if (this.stopping || this.ended) throw new Error('Background audio muting is no longer active.')
    if (this.playPending) throw new Error('An activation sound is already playing.')
    return await new Promise<void>((resolve, reject) => {
      const id = String(++this.sequence)
      const timer = setTimeout(() => this.failed(new Error('The activation sound took too long. Dictation was cancelled and other audio restored.')), 5_000)
      timer.unref()
      this.playPending = { id, resolve, reject, timer }
      this.child.stdin.write(JSON.stringify({ action: 'play', path, id }) + '\n')
    })
  }

  stop(): Promise<void> {
    if (this.stopping || this.ended) return this.closed
    this.stopping = true
    clearTimeout(this.readyTimer)
    if (!this.readySettled) { this.readySettled = true; this.readyReject(cancelled()) }
    this.rejectPlayback(cancelled())
    this.child.stdin.end(JSON.stringify({ action: 'stop' }) + '\n')
    this.stopTimer = setTimeout(() => { if (!this.ended) this.child.kill('SIGTERM') }, 500)
    this.killTimer = setTimeout(() => { if (!this.ended) this.child.kill('SIGKILL') }, 1_000)
    this.stopTimer.unref(); this.killTimer.unref()
    return this.closed
  }
}
