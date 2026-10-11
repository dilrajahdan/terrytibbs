import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import type { TerryAPI } from '../src/shared/types'
import { createCaptureController, type CaptureControllerOptions } from '../src/renderer/recorder'

type Listener = (...args: unknown[]) => void

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null
  readonly posted: Array<Record<string, unknown>> = []
  closed = false
  captureId: number | undefined

  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message)
    if (message.type === 'begin') this.captureId = message.captureId as number
    if (message.type === 'arm') this.captureId = undefined
    if (message.type === 'flush') {
      queueMicrotask(() => this.onmessage?.({ data: { type: 'flushed', requestId: message.requestId, captureId: message.captureId } }))
    }
  }

  emit(data: Record<string, unknown>): void { this.onmessage?.({ data: { captureId: this.captureId, ...data } }) }
  close(): void { this.closed = true }
}

class FakeTrack {
  readyState: MediaStreamTrackState = 'live'
  muted = false
  label = 'Desk microphone'
  private readonly listeners = new Map<string, Set<Listener>>()

  getSettings(): MediaTrackSettings { return { deviceId: 'mic-1', sampleRate: 16_000 } }
  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, listener: Listener): void { this.listeners.get(type)?.delete(listener) }
  emit(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener() }
  stop(): void { this.readyState = 'ended' }
}

class FakeSource {
  connected = false
  connect(): void { this.connected = true }
  disconnect(): void { this.connected = false }
}

class FakeGain {
  gain = { value: 1 }
  connect(): void {}
  disconnect(): void {}
}

class FakeNode {
  readonly port = new FakePort()
  connected = false
  connect(): void { this.connected = true }
  disconnect(): void { this.connected = false }
}

class FakeContext {
  moduleReady: Promise<void> | null = null
  readonly audioWorklet = {
    addModule: async (url: string) => {
      this.moduleUrl = url
      if (this.moduleReady) await this.moduleReady
    }
  }
  readonly destination = {}
  readonly sampleRate = 16_000
  state: AudioContextState = 'running'
  moduleUrl = ''
  closed = false
  private readonly listeners = new Set<Listener>()
  readonly source = new FakeSource()
  readonly output = new FakeGain()

  createMediaStreamSource(): MediaStreamAudioSourceNode { return this.source as unknown as MediaStreamAudioSourceNode }
  createGain(): GainNode { return this.output as unknown as GainNode }
  async resume(): Promise<void> { this.state = 'running' }
  async close(): Promise<void> { this.closed = true; this.state = 'closed' }
  addEventListener(type: string, listener: Listener): void { if (type === 'statechange') this.listeners.add(listener) }
  removeEventListener(type: string, listener: Listener): void { if (type === 'statechange') this.listeners.delete(listener) }
}

interface Harness {
  controller: ReturnType<typeof createCaptureController>
  track: FakeTrack
  node: FakeNode
  context: FakeContext
  constraints: MediaStreamConstraints | null
  events: {
    started: Array<{ id: number; device: unknown }>
    warning: string[]
    levels: number[]
    complete: Float32Array[]
    failed: string[]
    failedSamples: Array<Float32Array | undefined>
    prepared: Array<{ ready: boolean; device?: unknown; message?: string }>
  }
}

function harness(
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
  configureContext?: (context: FakeContext) => void,
  options: CaptureControllerOptions = {}
): Harness {
  const track = new FakeTrack()
  const context = new FakeContext()
  configureContext?.(context)
  const node = new FakeNode()
  let constraints: MediaStreamConstraints | null = null
  const events = { started: [], warning: [], levels: [], complete: [], failed: [], failedSamples: [], prepared: [] } as Harness['events']
  const api = {
    capturePrepared: (ready: boolean, device?: unknown, message?: string) => events.prepared.push({ ready, device, message }),
    captureStarted: (id: number, device: unknown) => events.started.push({ id, device }),
    captureWarning: (_id: number, message: string) => events.warning.push(message),
    captureLevel: (_id: number, level: number) => events.levels.push(level),
    captureComplete: (_id: number, samples: Float32Array) => events.complete.push(samples),
    captureFailed: (_id: number, message: string, samples?: Float32Array) => {
      events.failed.push(message)
      events.failedSamples.push(samples)
    }
  } as unknown as TerryAPI
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track]
  } as unknown as MediaStream
  const controller = createCaptureController(api, {
    getUserMedia: async requested => {
      constraints = requested
      return getUserMedia ? getUserMedia(requested) : stream
    },
    createAudioContext: () => context as unknown as AudioContext,
    createWorkletNode: () => node as unknown as AudioWorkletNode,
    workletUrl: '/asset/capture-worklet.js',
    ...options
  })
  return {
    controller, track, node, context, events,
    get constraints(): MediaStreamConstraints | null { return constraints }
  }
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

test('AudioWorklet capture starts after and retains the first and partial final blocks', async () => {
  const testHarness = harness()
  testHarness.controller.handle({ action: 'start', sessionId: 7, microphoneId: 'mic-1' })
  await flushMicrotasks()

  const audio = testHarness.constraints?.audio as MediaTrackConstraints
  assert.deepEqual(audio.deviceId, { exact: 'mic-1' })
  assert.equal(testHarness.context.moduleUrl, '/asset/capture-worklet.js')

  testHarness.node.port.emit({ type: 'audio', samples: new Float32Array([1, 2, 3]) })
  assert.equal(testHarness.events.started.length, 1)
  assert.deepEqual(testHarness.events.started[0]?.device, {
    deviceId: 'mic-1', label: 'Desk microphone', sampleRate: 16_000
  })
  testHarness.node.port.emit({ type: 'audio', samples: new Float32Array([4, 5]) })
  testHarness.controller.handle({ action: 'stop', sessionId: 7 })
  await flushMicrotasks()

  assert.deepEqual([...testHarness.events.complete[0] ?? []], [1, 2, 3, 4, 5])
  assert.deepEqual(testHarness.events.failed, [])
  assert.equal(testHarness.track.readyState, 'ended')
  assert.equal(testHarness.context.closed, true)
})

test('cancel discards queued worklet messages and never emits a late completion', async () => {
  const testHarness = harness()
  testHarness.controller.handle({ action: 'start', sessionId: 8 })
  await flushMicrotasks()
  testHarness.node.port.emit({ type: 'audio', samples: new Float32Array([0.5, 0.5]) })
  testHarness.controller.handle({ action: 'cancel', sessionId: 8 })
  testHarness.node.port.emit({ type: 'audio', samples: new Float32Array([0.9]) })
  await flushMicrotasks()

  assert.deepEqual(testHarness.events.complete, [])
  assert.deepEqual(testHarness.events.failed, [])
  assert.equal(testHarness.track.readyState, 'ended')
  assert.equal(testHarness.context.closed, true)
  assert.equal(testHarness.node.port.closed, true)
})

test('an explicitly selected missing microphone fails without retrying the default input', async () => {
  let calls = 0
  const testHarness = harness(async () => {
    calls += 1
    throw new DOMException('missing', 'OverconstrainedError')
  })
  testHarness.controller.handle({ action: 'start', sessionId: 9, microphoneId: 'missing-mic' })
  await flushMicrotasks()

  assert.equal(calls, 1)
  assert.match(testHarness.events.failed[0] ?? '', /No usable microphone/)
  assert.equal(testHarness.context.closed, true)
})

test('cancel during worklet module loading does not open the microphone', async () => {
  let resolveModule!: () => void
  const moduleReady = new Promise<void>(resolve => { resolveModule = resolve })
  let microphoneRequests = 0
  const testHarness = harness(async () => {
    microphoneRequests += 1
    throw new Error('getUserMedia must not be called')
  }, context => { context.moduleReady = moduleReady })

  testHarness.controller.handle({ action: 'start', sessionId: 10 })
  await flushMicrotasks()
  testHarness.controller.handle({ action: 'cancel', sessionId: 10 })
  assert.equal(testHarness.context.closed, true)
  resolveModule()
  await flushMicrotasks()

  assert.equal(microphoneRequests, 0)
  assert.deepEqual(testHarness.events.failed, [])
})

test('cancel during permission closes the prepared graph before a late stream resolves', async () => {
  let resolveMicrophone!: (stream: MediaStream) => void
  const microphonePending = new Promise<MediaStream>(resolve => { resolveMicrophone = resolve })
  const testHarness = harness(() => microphonePending)

  testHarness.controller.handle({ action: 'start', sessionId: 11 })
  await flushMicrotasks()
  testHarness.controller.handle({ action: 'cancel', sessionId: 11 })
  assert.equal(testHarness.context.closed, true)
  assert.equal(testHarness.node.port.closed, true)

  const lateStream = {
    getAudioTracks: () => [testHarness.track],
    getTracks: () => [testHarness.track]
  } as unknown as MediaStream
  resolveMicrophone(lateStream)
  await flushMicrotasks()
  assert.equal(testHarness.track.readyState, 'ended')
  assert.deepEqual(testHarness.events.complete, [])
  assert.deepEqual(testHarness.events.failed, [])
})

test('a microphone disconnect retains a usable partial prefix for explicit recovery', async () => {
  const testHarness = harness()
  testHarness.controller.handle({ action: 'start', sessionId: 12 })
  await flushMicrotasks()
  testHarness.node.port.emit({ type: 'audio', samples: new Float32Array(4_800).fill(0.2) })
  testHarness.track.emit('ended')
  await flushMicrotasks()

  assert.match(testHarness.events.failed[0] ?? '', /disconnected/)
  assert.equal(testHarness.events.failedSamples[0]?.length, 4_800)
  assert.deepEqual(testHarness.events.complete, [])
})

test('the worklet latches stopped after flushing and emits no later audio', async () => {
  const source = await readFile(new URL('../src/renderer/capture-worklet.js', import.meta.url), 'utf8')
  const messages: Array<Record<string, unknown>> = []
  let Processor!: new () => { port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage(message: Record<string, unknown>): void }; process(inputs: unknown[], outputs: unknown[]): boolean }
  class FakeProcessor {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: Record<string, unknown>) => { messages.push(message) }
    }
  }
  vm.runInNewContext(source, {
    AudioWorkletProcessor: FakeProcessor,
    registerProcessor: (_name: string, processor: new () => unknown) => { Processor = processor as typeof Processor }
  })
  const processor = new Processor()
  const frame = new Float32Array(128).fill(0.2)
  processor.process([[frame]], [[new Float32Array(128)]])
  processor.port.onmessage?.({ data: { type: 'flush', requestId: 1 } })
  assert.equal(messages.at(-1)?.type, 'flushed')
  messages.length = 0
  processor.process([[frame]], [[new Float32Array(128)]])
  assert.deepEqual(messages, [])
})

test('armed capture is opt-in and repeated disabled prepare calls leave a cold recording alone', async () => {
  const subject = harness()
  assert.equal(subject.constraints, null)
  subject.controller.prepare(false, 'mic-1')
  assert.equal(subject.constraints, null)
  subject.controller.handle({ action: 'start', sessionId: 20, microphoneId: 'mic-1' })
  await flushMicrotasks()
  subject.node.port.emit({ type: 'audio', samples: new Float32Array([0.2]) })
  subject.controller.prepare(false, 'mic-1')
  subject.controller.prepare(false, 'mic-2')
  assert.equal(subject.track.readyState, 'live')
  subject.controller.handle({ action: 'stop', sessionId: 20 })
  await flushMicrotasks()
  assert.deepEqual(Array.from(subject.events.complete[0]), [Math.fround(0.2)])
})

test('ready graph is reused immediately and returns to idle without publishing idle samples or levels', async () => {
  const subject = harness()
  subject.controller.prepare(true, 'mic-1')
  await flushMicrotasks()
  assert.equal(subject.events.prepared.at(-1)?.ready, false, 'Permission alone must not report a ready microphone')
  assert.equal(subject.node.port.posted.at(-1)?.type, 'arm')
  subject.node.port.emit({ type: 'prepared' })
  assert.equal(subject.events.prepared.at(-1)?.ready, true)
  subject.node.port.emit({ type: 'audio', samples: new Float32Array([9]) })
  subject.node.port.emit({ type: 'level', level: 0.9 })
  assert.deepEqual(subject.events.started, [])
  assert.deepEqual(subject.events.levels, [])
  assert.deepEqual(subject.events.complete, [])
  const postedBefore = subject.node.port.posted.length
  subject.controller.prepare(true, 'mic-1')
  assert.equal(subject.node.port.posted.length, postedBefore, 'A repeated state update must not rebuild or reset the graph')

  subject.controller.handle({ action: 'start', sessionId: 21, microphoneId: 'mic-1' })
  assert.equal(subject.node.port.posted.at(-1)?.type, 'begin', 'Warm start must issue begin synchronously, without another getUserMedia promise')
  assert.equal(subject.node.port.posted.at(-1)?.includePreRoll, true)
  subject.node.port.emit({ type: 'audio', samples: new Float32Array([1, 2]) })
  subject.controller.handle({ action: 'stop', sessionId: 21 })
  await flushMicrotasks()
  assert.deepEqual(Array.from(subject.events.complete[0]), [1, 2])
  assert.equal(subject.track.readyState, 'live')
  assert.equal(subject.context.closed, false)
  assert.equal(subject.node.port.posted.at(-1)?.type, 'arm')
  subject.node.port.emit({ type: 'audio', samples: new Float32Array([7]) })
  subject.node.port.emit({ type: 'level', level: 0.8 })
  assert.equal(subject.events.complete.length, 1)
  assert.deepEqual(subject.events.levels, [0])
  subject.controller.destroy()
  assert.equal(subject.track.readyState, 'ended')
  assert.equal(subject.node.port.closed, true)
})

test('cancel and restart reject every old session frame and flush acknowledgement', async () => {
  const subject = harness()
  subject.controller.prepare(true, 'mic-1')
  await flushMicrotasks()
  subject.node.port.emit({ type: 'prepared' })
  subject.controller.handle({ action: 'start', sessionId: 22, microphoneId: 'mic-1' })
  const oldId = subject.node.port.captureId
  subject.node.port.emit({ type: 'audio', samples: new Float32Array([1]) })
  subject.controller.handle({ action: 'stop', sessionId: 22 })
  const oldFlush = subject.node.port.posted.at(-1)?.requestId
  subject.controller.handle({ action: 'cancel', sessionId: 22 })
  subject.controller.handle({ action: 'start', sessionId: 23, microphoneId: 'mic-1', includePreRoll: false })
  assert.equal(subject.node.port.posted.at(-1)?.includePreRoll, false)
  subject.node.port.emit({ type: 'audio', captureId: oldId, samples: new Float32Array([999]) })
  subject.node.port.emit({ type: 'level', captureId: oldId, level: 1 })
  subject.node.port.emit({ type: 'flushed', captureId: oldId, requestId: oldFlush })
  subject.node.port.emit({ type: 'audio', samples: new Float32Array([2, 3]) })
  subject.controller.handle({ action: 'stop', sessionId: 23 })
  await flushMicrotasks()
  assert.equal(subject.events.complete.length, 1)
  assert.deepEqual(Array.from(subject.events.complete[0]), [2, 3])
  assert.deepEqual(subject.events.failed, [])
  assert.deepEqual(subject.events.started.map(event => event.id), [22, 23])
  subject.controller.destroy()
})

test('idle device loss marks preparation unavailable without inventing a failed dictation', async () => {
  const subject = harness()
  subject.controller.prepare(true, 'mic-1')
  await flushMicrotasks()
  subject.node.port.emit({ type: 'prepared' })
  subject.track.emit('ended')
  assert.equal(subject.events.prepared.at(-1)?.ready, false)
  assert.match(subject.events.prepared.at(-1)?.message ?? '', /disconnected/)
  assert.deepEqual(subject.events.failed, [])
  assert.deepEqual(subject.events.warning, [])
  assert.deepEqual(subject.events.complete, [])
  assert.equal(subject.track.readyState, 'ended')
  assert.equal(subject.context.closed, true)
  subject.controller.destroy()
})

test('suspending an idle graph closes the microphone, port and audio context immediately', async () => {
  const subject = harness()
  subject.controller.prepare(true, 'mic-1')
  await flushMicrotasks()
  subject.node.port.emit({ type: 'prepared' })
  subject.controller.suspend()
  assert.equal(subject.track.readyState, 'ended')
  assert.equal(subject.context.closed, true)
  assert.equal(subject.node.port.closed, true)
  assert.equal(subject.events.prepared.at(-1)?.ready, false)
  subject.node.port.emit({ type: 'prepared' })
  assert.equal(subject.events.prepared.at(-1)?.ready, false)
  assert.deepEqual(subject.events.complete, [])
  subject.controller.destroy()
})

test('withdrawing permission during prepare closes a late stream and never reports ready', async () => {
  let resolveMicrophone!: (stream: MediaStream) => void
  const microphonePending = new Promise<MediaStream>(resolve => { resolveMicrophone = resolve })
  const subject = harness(() => microphonePending)
  subject.controller.prepare(true, 'mic-1')
  await flushMicrotasks()
  subject.controller.prepare(false, 'mic-1')
  assert.equal(subject.context.closed, true)
  assert.equal(subject.node.port.closed, true)
  resolveMicrophone({ getAudioTracks: () => [subject.track], getTracks: () => [subject.track] } as unknown as MediaStream)
  await flushMicrotasks()
  assert.equal(subject.track.readyState, 'ended')
  assert.equal(subject.events.prepared.some(event => event.ready), false)
  assert.deepEqual(subject.events.failed, [])
  subject.controller.destroy()
})

test('pressing during preparation promotes the original pending permission request', async () => {
  let resolveMicrophone!: (stream: MediaStream) => void
  let requests = 0
  const microphonePending = new Promise<MediaStream>(resolve => { resolveMicrophone = resolve })
  const subject = harness(() => { requests += 1; return microphonePending })
  subject.controller.prepare(true, 'mic-1')
  await flushMicrotasks()
  subject.controller.handle({ action: 'start', sessionId: 24, microphoneId: 'mic-1', includePreRoll: false })
  resolveMicrophone({ getAudioTracks: () => [subject.track], getTracks: () => [subject.track] } as unknown as MediaStream)
  await flushMicrotasks()
  assert.equal(requests, 1)
  assert.equal(subject.node.port.posted.at(-1)?.type, 'begin')
  assert.equal(subject.node.port.posted.at(-1)?.includePreRoll, false)
  subject.node.port.emit({ type: 'audio', samples: new Float32Array([0.4]) })
  assert.equal(subject.events.started[0]?.id, 24)
  subject.controller.handle({ action: 'stop', sessionId: 24 })
  await flushMicrotasks()
  assert.equal(subject.events.complete.length, 1)
  assert.equal(subject.track.readyState, 'live')
  subject.controller.destroy()
})

test('idle readiness has no recording deadline or silence warnings, while recorded audio remains capped at 120 seconds', async () => {
  const timers = new Map<number, { callback: () => void; delay: number }>()
  let nextTimer = 0
  const subject = harness(undefined, undefined, {
    setTimeout: ((callback: () => void, delay: number) => {
      const id = ++nextTimer
      timers.set(id, { callback, delay })
      return id
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => { timers.delete(id) }) as unknown as typeof clearTimeout
  })
  subject.controller.prepare(true, 'mic-1')
  await flushMicrotasks()
  assert.deepEqual([...timers.values()].map(timer => timer.delay), [5_000], 'Only first-frame readiness may time out while idle')
  subject.node.port.emit({ type: 'prepared' })
  assert.equal(timers.size, 0, 'A ready idle microphone must not schedule transcription, a 2-minute recording stop, or input warnings')
  assert.deepEqual(subject.events.warning, [])
  subject.controller.handle({ action: 'start', sessionId: 25, microphoneId: 'mic-1' })
  assert.equal([...timers.values()].some(timer => timer.delay === 120_000), true)
  subject.node.port.emit({ type: 'audio', samples: new Float32Array(16_000 * 120 + 500).fill(0.2) })
  subject.controller.handle({ action: 'stop', sessionId: 25 })
  await flushMicrotasks()
  assert.equal(subject.events.complete[0]?.length, 16_000 * 120)
  assert.equal(timers.size, 0, 'Returning to idle must clear recording and warning deadlines')
  subject.controller.destroy()
})

test('switching the armed device closes an old pending stream without closing or publishing over the new graph', async () => {
  const contexts = [new FakeContext(), new FakeContext()]
  const nodes = [new FakeNode(), new FakeNode()]
  const oldTrack = new FakeTrack()
  const newTrack = new FakeTrack()
  newTrack.label = 'Replacement microphone'
  const stream = (track: FakeTrack) => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream
  let resolveOld!: (stream: MediaStream) => void
  let contextIndex = 0
  let nodeIndex = 0
  const subject = harness(async constraints => {
    const device = (constraints.audio as MediaTrackConstraints).deviceId as { exact: string }
    return device.exact === 'old-mic' ? new Promise<MediaStream>(resolve => { resolveOld = resolve }) : stream(newTrack)
  }, undefined, {
    createAudioContext: () => contexts[contextIndex++] as unknown as AudioContext,
    createWorkletNode: () => nodes[nodeIndex++] as unknown as AudioWorkletNode
  })
  subject.controller.prepare(true, 'old-mic')
  await flushMicrotasks()
  subject.controller.prepare(true, 'new-mic')
  await flushMicrotasks()
  nodes[1].port.emit({ type: 'prepared' })
  assert.equal(contexts[0].closed, true)
  assert.equal(nodes[0].port.closed, true)
  assert.equal(subject.events.prepared.at(-1)?.ready, true)
  const reportCount = subject.events.prepared.length
  resolveOld(stream(oldTrack))
  await flushMicrotasks()
  assert.equal(oldTrack.readyState, 'ended')
  assert.equal(newTrack.readyState, 'live')
  assert.equal(contexts[1].closed, false)
  assert.equal(subject.events.prepared.length, reportCount, 'A stale permission continuation must not publish not-ready over the replacement graph')
  subject.controller.handle({ action: 'start', sessionId: 26, microphoneId: 'new-mic' })
  nodes[1].port.emit({ type: 'audio', samples: new Float32Array([0.6]) })
  subject.controller.handle({ action: 'stop', sessionId: 26 })
  await flushMicrotasks()
  assert.deepEqual(subject.events.complete.map(samples => Array.from(samples)), [[Math.fround(0.6)]])
  assert.deepEqual(subject.events.failed, [])
  subject.controller.destroy()
  assert.equal(newTrack.readyState, 'ended')
})
