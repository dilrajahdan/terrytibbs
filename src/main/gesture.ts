export type RecordingMode = 'hold' | 'locked' | null
export interface GestureHooks {
  canStart(): boolean
  start(mode: Exclude<RecordingMode, null>): void
  stop(): void
  mode(mode: RecordingMode): void
  now?(): number
  schedule?(callback: () => void, delay: number): unknown
  unschedule?(timer: unknown): void
}

// A short first tap leaves a 300 ms window for the second tap. A genuine hold
// finishes immediately on release. Native autorepeat and duplicate edges are ignored.
export class ShortcutGesture {
  private pressed = false
  private downAt = 0
  private tapTimer: unknown = null
  private current: RecordingMode = null
  private readonly now: () => number
  private readonly schedule: (callback: () => void, delay: number) => unknown
  private readonly unschedule: (timer: unknown) => void
  constructor(private readonly hooks: GestureHooks) {
    this.now = hooks.now ?? Date.now
    this.schedule = hooks.schedule ?? ((callback, delay) => setTimeout(callback, delay))
    this.unschedule = hooks.unschedule ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  }
  down(): void {
    if (this.pressed) return
    this.pressed = true
    if (this.current === 'locked') { this.finish(); return }
    if (this.tapTimer !== null) {
      this.clearTap()
      this.setMode('locked')
      return
    }
    if (this.current || !this.hooks.canStart()) return
    this.downAt = this.now()
    this.setMode('hold')
    this.hooks.start('hold')
  }
  up(): void {
    if (!this.pressed) return
    this.pressed = false
    if (this.current !== 'hold') return
    if (this.now() - this.downAt >= 220) { this.finish(); return }
    this.tapTimer = this.schedule(() => { this.tapTimer = null; this.finish() }, 300)
  }
  beginLocked(): void {
    if (!this.hooks.canStart()) return
    this.reset()
    this.setMode('locked')
    this.hooks.start('locked')
  }
  reset(): void {
    this.clearTap()
    this.pressed = false
    this.setMode(null)
  }
  private finish(): void {
    this.clearTap()
    this.setMode(null)
    this.hooks.stop()
  }
  private clearTap(): void {
    if (this.tapTimer !== null) this.unschedule(this.tapTimer)
    this.tapTimer = null
  }
  private setMode(mode: RecordingMode): void { this.current = mode; this.hooks.mode(mode) }
}
