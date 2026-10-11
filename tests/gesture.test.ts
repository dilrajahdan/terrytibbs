import test from 'node:test'
import assert from 'node:assert/strict'
import { ShortcutGesture } from '../src/main/gesture'

function harness() {
  let now = 0, allowed = true, next = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const calls: string[] = []
  const gesture = new ShortcutGesture({
    canStart: () => allowed,
    start: mode => calls.push(`start:${mode}`), stop: () => calls.push('stop'), mode: mode => calls.push(`mode:${mode}`),
    now: () => now,
    schedule: (fn, delay) => { const id = ++next; timers.set(id, { at: now + delay, fn }); return id },
    unschedule: timer => { timers.delete(timer as number) }
  })
  return { gesture, calls, busy: () => { allowed = false }, advance(ms: number) { now += ms; for (const [id, t] of timers) if (t.at <= now) { timers.delete(id); t.fn() } } }
}
test('hold ends immediately on release and ignores repeat downs', () => {
  const h = harness(); h.gesture.down(); h.gesture.down(); h.advance(500); h.gesture.up(); h.gesture.up()
  assert.deepEqual(h.calls, ['mode:hold', 'start:hold', 'mode:null', 'stop'])
})
test('two quick taps lock; the next press finishes once', () => {
  const h = harness(); h.gesture.down(); h.advance(50); h.gesture.up(); h.advance(100); h.gesture.down(); h.gesture.up(); h.advance(1000)
  assert.deepEqual(h.calls, ['mode:hold', 'start:hold', 'mode:locked'])
  h.gesture.down(); h.gesture.down(); h.gesture.up()
  assert.deepEqual(h.calls.slice(-2), ['mode:null', 'stop'])
  assert.equal(h.calls.filter(c => c === 'stop').length, 1)
})
test('single quick tap finishes after the second-tap window', () => {
  const h = harness(); h.gesture.down(); h.advance(20); h.gesture.up(); h.advance(299)
  assert.equal(h.calls.includes('stop'), false); h.advance(1); assert.equal(h.calls.at(-1), 'stop')
})
test('cancel resets a pending tap and allows the next recording', () => {
  const h = harness(); h.gesture.down(); h.gesture.up(); h.gesture.reset(); h.advance(1000)
  assert.equal(h.calls.includes('stop'), false)
  h.gesture.down(); h.advance(400); h.gesture.up(); assert.equal(h.calls.at(-1), 'stop')
})
test('busy events cannot start a session; button lock can finish via shortcut', () => {
  const h = harness(); h.gesture.beginLocked(); h.gesture.down(); h.gesture.up(); h.busy(); h.gesture.down(); h.gesture.up()
  assert.equal(h.calls.filter(c => c.startsWith('start')).length, 1)
  assert.equal(h.calls.filter(c => c === 'stop').length, 1)
})
