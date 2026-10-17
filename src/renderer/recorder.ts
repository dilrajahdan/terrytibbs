import type { CaptureCommand, InputDevice, TerryAPI } from '../shared/types'

const TARGET_RATE = 16_000
const MAX_RECORDING_MS = 120_000
const LEVEL_INTERVAL_MS = 100
const INITIAL_NO_INPUT_GRACE_MS = 2_500
const PAUSE_WARNING_GRACE_MS = 15_000
const CONTEXT_GRACE_MS = 1_500
const FIRST_FRAME_TIMEOUT_MS = 5_000
const FLUSH_TIMEOUT_MS = 1_000
const CONTEXT_RESUME_TIMEOUT_MS = 750
const NO_INPUT_LEVEL = 0.003
const RECOVERY_DELAYS_MS = [250, 1_000, 3_000]
const RECOVERY_STABLE_MS = 30_000

type Timer = ReturnType<typeof setTimeout>

interface WorkletAudioMessage { type: 'audio'; samples: Float32Array; captureId: number }
interface WorkletLevelMessage { type: 'level'; level: number; captureId: number }
interface WorkletFlushedMessage { type: 'flushed'; requestId: number; captureId: number }
interface WorkletPreparedMessage { type: 'prepared' }
type WorkletMessage = WorkletAudioMessage | WorkletLevelMessage | WorkletFlushedMessage | WorkletPreparedMessage

export interface CaptureControllerOptions {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  createAudioContext?: (options: AudioContextOptions) => AudioContext
  createWorkletNode?: (context: AudioContext, url: string) => AudioWorkletNode
  workletUrl?: string
  now?: () => number
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}

interface CaptureGraph {
  stream: MediaStream
  track: MediaStreamTrack
  context: AudioContext
  source: MediaStreamAudioSourceNode
  processor: AudioWorkletNode
  silentOutput: GainNode
  inputDevice: InputDevice
  microphoneId?: string
  ready: boolean
  preparedTimeout: Timer | null
  ended: () => void
  muted: () => void
  unmuted: () => void
  stateChanged: () => void
}

interface ActiveCapture extends CaptureGraph {
  sessionId: number
  generation: number
  captureId: number
  graph: CaptureGraph
  chunks: Float32Array[]
  sampleCount: number
  maxSamples: number
  sampleRate: number
  timeout: Timer
  firstFrameTimeout: Timer
  noInputTimer: Timer | null
  contextTimer: Timer | null
  stopping: boolean
  firstFrameReceived: boolean
  hasSignal: boolean
  mutedAt: number | null
  lastSignalAt: number | null
  lastLevelAt: number
  warningInput: boolean
  warningMuted: boolean
  warningContext: boolean
  publishedWarning: string | null
  flushRequestId: number
  stopPromise: Promise<boolean> | null
  settleFlush: ((acknowledged: boolean) => void) | null
}

interface PendingResources {
  generation: number
  context: AudioContext
  processor: AudioWorkletNode | null
  output: GainNode | null
  stream: MediaStream | null
}

export function createCaptureController(api: TerryAPI, options: CaptureControllerOptions = {}) {
  const getUserMedia = options.getUserMedia ?? ((constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints))
  const createAudioContext = options.createAudioContext ?? ((contextOptions: AudioContextOptions) => new AudioContext(contextOptions))
  const createWorkletNode = options.createWorkletNode ?? ((context: AudioContext, _url: string) => new AudioWorkletNode(context, 'terry-capture-processor'))
  const workletUrl = options.workletUrl ?? new URL('./capture-worklet.js', import.meta.url).toString()
  const now = options.now ?? (() => performance.now())
  const setTimer = options.setTimeout ?? setTimeout
  const clearTimer = options.clearTimeout ?? clearTimeout

  let active: ActiveCapture | null = null
  let graph: CaptureGraph | null = null
  let pendingSession: number | null = null
  let pendingResources: PendingResources | null = null
  let generation = 0
  let destroyed = false
  let armedEnabled = false
  let armedMicrophoneId: string | undefined
  let suspended = false
  let nextFlushRequestId = 0
  let nextCaptureId = 0
  let recoveryTimer: Timer | null = null
  let recoveryAttempts = 0
  let readySince: number | null = null
  let permissionBlocked = false

  function reportPrepared(ready: boolean, inputDevice?: InputDevice, message?: string): void {
    api.capturePrepared?.(ready, inputDevice, message)
  }

  function clearRecoveryTimer(): void {
    if (recoveryTimer !== null) clearTimer(recoveryTimer)
    recoveryTimer = null
  }

  function resetRecovery(): void {
    clearRecoveryTimer()
    recoveryAttempts = 0
    readySince = null
    permissionBlocked = false
  }

  function mayPrepare(): boolean {
    return armedEnabled && !suspended && !destroyed && !active && !pendingResources
  }

  function scheduleRecovery(): void {
    if (!mayPrepare() || graph || recoveryTimer !== null || permissionBlocked) return
    // A brief successful connection must not reset the budget for a flapping
    // device. No timer or background polling is needed while audio is healthy.
    if (readySince !== null && now() - readySince >= RECOVERY_STABLE_MS) recoveryAttempts = 0
    readySince = null
    if (recoveryAttempts >= RECOVERY_DELAYS_MS.length) return
    const delay = RECOVERY_DELAYS_MS[recoveryAttempts++]
    const ownerGeneration = generation
    recoveryTimer = setTimer(() => {
      recoveryTimer = null
      if (generation !== ownerGeneration || !mayPrepare() || graph || permissionBlocked) return
      void openGraph(null, armedMicrophoneId)
    }, delay)
  }

  function retryPreparation(): boolean {
    if (!mayPrepare()) return false
    resetRecovery()
    cancel(undefined, false)
    void openGraph(null, armedMicrophoneId)
    return true
  }

  function devicesChanged(): void {
    // Device events can also describe an unrelated output. Preserve a healthy
    // graph and active dictation; only an unavailable selected input needs retry.
    if (!mayPrepare() || graph || permissionBlocked) return
    retryPreparation()
  }

  function prepare(enabled: boolean, microphoneId?: string): void {
    if (!enabled && !armedEnabled) {
      armedMicrophoneId = microphoneId
      suspended = false
      return
    }
    const changed = armedEnabled !== enabled || armedMicrophoneId !== microphoneId || suspended
    armedEnabled = enabled
    armedMicrophoneId = microphoneId
    suspended = false
    if (destroyed || !changed) return
    resetRecovery()
    // Changing the selected device or withdrawing consent closes every old track,
    // including one whose permission promise has not resolved yet.
    cancel(undefined, false)
    if (enabled) void openGraph(null, microphoneId)
  }

  function suspend(): void {
    suspended = true
    cancel(undefined, false)
  }

  function shouldKeepReady(captureGraph: CaptureGraph): boolean {
    return armedEnabled && !suspended && !destroyed && captureGraph.microphoneId === armedMicrophoneId &&
      captureGraph.track.readyState === 'live' && captureGraph.context.state === 'running'
  }

  function start(sessionId: number, microphoneId?: string, includePreRoll = true): void {
    if (destroyed || active?.sessionId === sessionId || pendingSession === sessionId) return
    clearRecoveryTimer()
    permissionBlocked = false
    if (active) cancelActive(true)
    if (graph && graph.microphoneId === microphoneId && shouldKeepReady(graph)) {
      generation += 1
      beginCapture(graph, sessionId, includePreRoll)
      return
    }
    // An in-flight preparation can be promoted without another permission request.
    if (pendingResources && pendingSession === null && armedEnabled && !suspended && armedMicrophoneId === microphoneId) {
      pendingSession = sessionId
      pendingIncludePreRoll = includePreRoll
      return
    }
    cancel(undefined, false)
    void openGraph(sessionId, microphoneId, includePreRoll)
  }

  let pendingIncludePreRoll = true

  async function openGraph(sessionId: number | null, microphoneId?: string, includePreRoll = true): Promise<void> {
    if (destroyed) return
    const attempt = ++generation
    pendingSession = sessionId
    pendingIncludePreRoll = includePreRoll
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    let preparedProcessor: AudioWorkletNode | null = null
    let preparedOutput: GainNode | null = null
    reportPrepared(false)
    const isCurrent = () => !destroyed && attempt === generation
    try {
      context = createAudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' })
      pendingResources = { generation: attempt, context, processor: null, output: null, stream: null }
      if (!context.audioWorklet) throw new Error('This device cannot prepare the local microphone capture engine.')
      await context.audioWorklet.addModule(workletUrl)
      if (!isCurrent()) return
      preparedProcessor = createWorkletNode(context, workletUrl)
      if (pendingResources?.generation === attempt) pendingResources.processor = preparedProcessor
      preparedOutput = context.createGain()
      if (pendingResources?.generation === attempt) pendingResources.output = preparedOutput
      preparedOutput.gain.value = 0
      preparedProcessor.connect(preparedOutput)
      preparedOutput.connect(context.destination)
      const audio: MediaTrackConstraints = {
        channelCount: 1, sampleRate: TARGET_RATE,
        echoCancellation: true, noiseSuppression: true, autoGainControl: true
      }
      if (microphoneId) audio.deviceId = { exact: microphoneId }
      stream = await getUserMedia({ audio, video: false })
      if (!isCurrent()) { stopTracks(stream); return }
      if (pendingResources?.generation === attempt) pendingResources.stream = stream
      const track = stream.getAudioTracks()[0]
      if (!track || track.readyState !== 'live') throw new Error('The selected microphone did not provide a live audio track.')
      await context.resume()
      if (!isCurrent()) { stopTracks(stream); return }
      const source = context.createMediaStreamSource(stream)
      const settings = track.getSettings()
      const inputDevice: InputDevice = {
        deviceId: settings.deviceId || microphoneId || 'default',
        label: track.label || (microphoneId ? 'Selected microphone' : 'Default microphone'),
        sampleRate: context.sampleRate
      }
      const prepared: CaptureGraph = {
        stream, track, context, source, processor: preparedProcessor,
        silentOutput: preparedOutput, inputDevice, microphoneId, ready: false, preparedTimeout: null,
        ended: () => graphFailed(prepared, 'The microphone disconnected while Terry was listening.'),
        muted: () => {
          if (graph !== prepared) return
          if (!active || active.graph !== prepared) { graphFailed(prepared, 'The selected microphone stopped providing audio.'); return }
          const capture = active
          if (capture.stopping) return
          capture.warningMuted = true
          capture.mutedAt = now()
          capture.lastSignalAt = capture.mutedAt
          scheduleNoInputCheck(capture, true)
        },
        unmuted: () => {
          if (!active || active.graph !== prepared || active.stopping) return
          const capture = active
          capture.warningMuted = false
          capture.warningInput = false
          capture.mutedAt = null
          capture.lastSignalAt = now()
          publishWarning(capture)
          scheduleNoInputCheck(capture, true)
        },
        stateChanged: () => {
          if (graph !== prepared) return
          if (active?.graph === prepared) handleContextState(active)
          else if (prepared.context.state !== 'running') graphFailed(prepared, 'The ready microphone was interrupted.')
        }
      }
      graph = prepared
      pendingResources = null
      const requestedSession = pendingSession
      pendingSession = null
      preparedProcessor.port.onmessage = event => handleGraphMessage(prepared, event.data as WorkletMessage)
      track.addEventListener('ended', prepared.ended)
      track.addEventListener('mute', prepared.muted)
      track.addEventListener('unmute', prepared.unmuted)
      context.addEventListener('statechange', prepared.stateChanged)
      if (requestedSession !== null) beginCapture(prepared, requestedSession, pendingIncludePreRoll)
      else {
        preparedProcessor.port.postMessage({ type: 'arm', preRollMs: 500 })
        prepared.preparedTimeout = setTimer(() => graphFailed(prepared, 'The ready microphone did not produce audio.'), FIRST_FRAME_TIMEOUT_MS)
      }
      source.connect(preparedProcessor)
      if (track.muted) prepared.muted()
    } catch (error) {
      const failedSession = active?.generation === attempt ? active.sessionId : pendingSession
      if (active?.generation === attempt) {
        clearCaptureTimers(active)
        active = null
      }
      if (stream) stopTracks(stream)
      if (graph && graph.context === context) closeGraph(graph)
      else closePendingResources(attempt)
      if (!isCurrent()) return
      pendingSession = null
      permissionBlocked = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      reportPrepared(false, undefined, captureErrorMessage(error))
      if (failedSession !== null) api.captureFailed(failedSession, captureErrorMessage(error))
      scheduleRecovery()
    }
  }

  function beginCapture(prepared: CaptureGraph, sessionId: number, includePreRoll: boolean): void {
    if (prepared.preparedTimeout !== null) clearTimer(prepared.preparedTimeout)
    prepared.preparedTimeout = null
    const capture: ActiveCapture = {
      ...prepared, graph: prepared, sessionId, generation, captureId: ++nextCaptureId,
      chunks: [], sampleCount: 0,
      maxSamples: Math.ceil(prepared.context.sampleRate * MAX_RECORDING_MS / 1000),
      sampleRate: prepared.context.sampleRate,
      timeout: setTimer(() => { void stop(sessionId) }, MAX_RECORDING_MS),
      firstFrameTimeout: setTimer(() => failActive(sessionId, 'The microphone did not produce audio. Check the input device and try again.'), FIRST_FRAME_TIMEOUT_MS),
      noInputTimer: null, contextTimer: null, stopping: false, firstFrameReceived: false,
      hasSignal: false, mutedAt: null, lastSignalAt: null, lastLevelAt: 0,
      warningInput: false, warningMuted: false, warningContext: false, publishedWarning: null,
      flushRequestId: 0, stopPromise: null, settleFlush: null
    }
    active = capture
    prepared.processor.port.postMessage({ type: 'begin', captureId: capture.captureId, includePreRoll })
  }

  function handleGraphMessage(prepared: CaptureGraph, message: WorkletMessage): void {
    if (graph !== prepared) return
    if (message.type === 'prepared') {
      prepared.ready = true
      readySince ??= now()
      if (prepared.preparedTimeout !== null) clearTimer(prepared.preparedTimeout)
      prepared.preparedTimeout = null
      if (shouldKeepReady(prepared)) reportPrepared(true, prepared.inputDevice)
      return
    }
    const capture = active
    if (!capture || capture.graph !== prepared || capture.generation !== generation || message.captureId !== capture.captureId) return
    if (message.type === 'audio') {
      appendSamples(capture, message.samples)
      if (!capture.firstFrameReceived) {
        capture.firstFrameReceived = true
        prepared.ready = true
        readySince ??= now()
        if (shouldKeepReady(prepared)) reportPrepared(true, prepared.inputDevice)
        capture.lastSignalAt = now()
        clearTimer(capture.firstFrameTimeout)
        api.captureStarted(capture.sessionId, capture.inputDevice)
        scheduleNoInputCheck(capture)
      }
      return
    }
    if (message.type === 'level') {
      if (capture.stopping) return
      const timestamp = now()
      if (timestamp - capture.lastLevelAt >= LEVEL_INTERVAL_MS) {
        api.captureLevel(capture.sessionId, Math.min(1, Math.max(0, message.level)))
        capture.lastLevelAt = timestamp
      }
      if (message.level >= NO_INPUT_LEVEL) {
        capture.lastSignalAt = timestamp
        capture.hasSignal = true
        capture.warningInput = false
        capture.warningMuted = false
        capture.mutedAt = null
        publishWarning(capture)
        scheduleNoInputCheck(capture, true)
        return
      }
      scheduleNoInputCheck(capture)
      return
    }
    if (message.type === 'flushed' && message.requestId === capture.flushRequestId) {
      capture.settleFlush?.(true)
      capture.settleFlush = null
    }
  }

  function graphFailed(prepared: CaptureGraph, message: string): void {
    if (graph !== prepared) return
    if (active?.graph === prepared) failActive(active.sessionId, message)
    else {
      closeGraph(prepared)
      reportPrepared(false, undefined, message)
      scheduleRecovery()
    }
  }

  function appendSamples(capture: ActiveCapture, incoming: Float32Array): void {
    if (incoming.length === 0 || capture.sampleCount >= capture.maxSamples) return
    const remaining = capture.maxSamples - capture.sampleCount
    const samples = incoming.length <= remaining ? incoming : incoming.subarray(0, remaining)
    capture.chunks.push(samples.slice())
    capture.sampleCount += samples.length
  }

  function scheduleNoInputCheck(capture: ActiveCapture, reset = false): void {
    if (capture.noInputTimer !== null && !reset) return
    if (capture.noInputTimer !== null) clearTimer(capture.noInputTimer)
    if (!capture.firstFrameReceived || capture.stopping) return
    const grace = capture.mutedAt !== null
      ? INITIAL_NO_INPUT_GRACE_MS
      : capture.hasSignal ? PAUSE_WARNING_GRACE_MS : INITIAL_NO_INPUT_GRACE_MS
    const deadline = (capture.lastSignalAt ?? now()) + grace
    capture.noInputTimer = setTimer(() => {
      capture.noInputTimer = null
      if (active !== capture || capture.stopping) return
      const lastSignalAt = capture.lastSignalAt ?? now()
      const grace = capture.mutedAt !== null
        ? INITIAL_NO_INPUT_GRACE_MS
        : capture.hasSignal ? PAUSE_WARNING_GRACE_MS : INITIAL_NO_INPUT_GRACE_MS
      if (now() - lastSignalAt >= grace) capture.warningInput = true
      publishWarning(capture)
      capture.lastSignalAt = now()
      scheduleNoInputCheck(capture)
    }, Math.max(0, deadline - now()))
  }

  function handleContextState(capture: ActiveCapture): void {
    if (active !== capture || capture.stopping) return
    const state = capture.context.state as string
    if (state === 'running') {
      if (capture.contextTimer !== null) clearTimer(capture.contextTimer)
      capture.contextTimer = null
      capture.warningContext = false
      publishWarning(capture)
      return
    }
    if (capture.contextTimer !== null) return
    capture.contextTimer = setTimer(() => {
      capture.contextTimer = null
      if (active !== capture || capture.stopping) return
      void resumeContext(capture)
    }, CONTEXT_GRACE_MS)
  }

  async function resumeContext(capture: ActiveCapture): Promise<void> {
    if (active !== capture || capture.stopping || (capture.context.state as string) === 'running') return
    const recovered = await new Promise<boolean>(resolve => {
      let finished = false
      const timeout = setTimer(() => {
        if (finished) return
        finished = true
        resolve(false)
      }, CONTEXT_RESUME_TIMEOUT_MS)
      void capture.context.resume().then(() => {
        if (finished) return
        finished = true
        clearTimer(timeout)
        resolve((capture.context.state as string) === 'running')
      }).catch(() => {
        if (finished) return
        finished = true
        clearTimer(timeout)
        resolve(false)
      })
    })
    if (active !== capture || capture.stopping) return
    if (recovered) {
      capture.warningContext = false
      publishWarning(capture)
      return
    }
    failActive(capture.sessionId, 'Microphone audio was interrupted. Restart dictation and try again.')
  }

  function publishWarning(capture: ActiveCapture): void {
    if (!capture.firstFrameReceived || capture.stopping) return
    const message = capture.warningContext
      ? 'Microphone audio is paused. Check the selected input device.'
      : capture.warningMuted || capture.warningInput
        ? 'No microphone input detected. Check the selected input device.'
        : ''
    if (capture.publishedWarning === message) return
    capture.publishedWarning = message
    api.captureWarning(capture.sessionId, message)
  }

  async function stop(sessionId: number): Promise<void> {
    if (pendingSession === sessionId && !active) {
      cancel(sessionId)
      return
    }
    if (!active || active.sessionId !== sessionId) return
    const capture = active
    if (capture.stopPromise) { await capture.stopPromise; return }
    capture.stopping = true
    clearCaptureTimers(capture)
    capture.stopPromise = new Promise<boolean>(resolve => { capture.settleFlush = resolve })
    capture.flushRequestId = ++nextFlushRequestId
    capture.processor.port.postMessage({ type: 'flush', requestId: capture.flushRequestId, captureId: capture.captureId })
    const flushTimer = setTimer(() => {
      capture.settleFlush?.(false)
      capture.settleFlush = null
    }, FLUSH_TIMEOUT_MS)
    const acknowledged = await capture.stopPromise
    clearTimer(flushTimer)
    if (active !== capture || capture.generation !== generation) return
    active = null
    releaseCapture(capture, acknowledged)
    if (!graph) scheduleRecovery()
    if (!acknowledged) {
      api.captureFailed(sessionId, 'Microphone capture did not finish cleanly. Try again.', recoverySamples(capture))
      return
    }
    if (capture.sampleCount === 0) {
      api.captureFailed(sessionId, 'No microphone audio was captured. Check the input device and try again.')
      return
    }
    api.captureLevel(sessionId, 0)
    api.captureComplete(sessionId, resampleMono(concatenate(capture.chunks), capture.sampleRate, TARGET_RATE))
  }

  function cancel(sessionId?: number, retainReady = true): void {
    if (sessionId !== undefined && active && active.sessionId !== sessionId) return
    if (sessionId !== undefined && pendingSession !== null && pendingSession !== sessionId) return
    clearRecoveryTimer()
    generation += 1
    pendingSession = null
    if (pendingResources) closePendingResources(pendingResources.generation)
    cancelActive(retainReady)
    if (graph && (!retainReady || !shouldKeepReady(graph))) closeGraph(graph)
    if (retainReady && armedEnabled && !suspended && !destroyed && !graph && !pendingResources) {
      void openGraph(null, armedMicrophoneId)
    }
  }

  function cancelActive(retainReady: boolean): void {
    if (!active) return
    const capture = active
    active = null
    capture.stopping = true
    capture.settleFlush?.(false)
    capture.settleFlush = null
    releaseCapture(capture, retainReady)
  }

  function clearCaptureTimers(capture: ActiveCapture): void {
    clearTimer(capture.timeout)
    clearTimer(capture.firstFrameTimeout)
    if (capture.noInputTimer !== null) clearTimer(capture.noInputTimer)
    if (capture.contextTimer !== null) clearTimer(capture.contextTimer)
  }

  function releaseCapture(capture: ActiveCapture, retainReady: boolean): void {
    clearCaptureTimers(capture)
    if (graph !== capture.graph) return
    if (retainReady && shouldKeepReady(graph)) {
      // arm resets the worklet's partial block and old recording identity before
      // any later begin; FIFO port messages make cancel/restart boundaries exact.
      graph.processor.port.postMessage({ type: 'arm', preRollMs: 500 })
      if (graph.ready) reportPrepared(true, graph.inputDevice)
    } else closeGraph(graph)
  }

  function closeGraph(prepared: CaptureGraph): void {
    if (graph === prepared) graph = null
    if (prepared.preparedTimeout !== null) clearTimer(prepared.preparedTimeout)
    prepared.track.removeEventListener('ended', prepared.ended)
    prepared.track.removeEventListener('mute', prepared.muted)
    prepared.track.removeEventListener('unmute', prepared.unmuted)
    prepared.context.removeEventListener('statechange', prepared.stateChanged)
    prepared.processor.port.onmessage = null
    prepared.processor.port.close()
    prepared.source.disconnect()
    prepared.processor.disconnect()
    prepared.silentOutput.disconnect()
    stopTracks(prepared.stream)
    void prepared.context.close().catch(() => undefined)
    reportPrepared(false)
  }

  function closePendingResources(ownerGeneration: number): void {
    const pending = pendingResources
    if (!pending || pending.generation !== ownerGeneration) return
    pendingResources = null
    if (pending.stream) stopTracks(pending.stream)
    pending.processor?.port.close()
    pending.processor?.disconnect()
    pending.output?.disconnect()
    void pending.context.close().catch(() => undefined)
    reportPrepared(false)
  }

  function failActive(sessionId: number, message: string): void {
    if (!active || active.sessionId !== sessionId) return
    const capture = active
    cancel(sessionId, false)
    api.captureFailed(sessionId, message, recoverySamples(capture))
    scheduleRecovery()
  }

  function handle(command: CaptureCommand): void {
    if (command.action === 'start') start(command.sessionId, command.microphoneId, command.includePreRoll)
    else if (command.action === 'stop') void stop(command.sessionId)
    else if (command.action === 'shutdown') suspend()
    else cancel(command.sessionId)
  }

  function destroy(): void {
    destroyed = true
    cancel(undefined, false)
  }

  return { handle, prepare, retryPreparation, devicesChanged, suspend, destroy }
}

function stopTracks(stream: MediaStream): void { for (const track of stream.getTracks()) track.stop() }

function concatenate(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const output = new Float32Array(length)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
  return output
}

function recoverySamples(capture: ActiveCapture): Float32Array | undefined {
  if (capture.sampleCount < Math.ceil(capture.sampleRate * 0.3)) return undefined
  return resampleMono(concatenate(capture.chunks), capture.sampleRate, TARGET_RATE)
}

export function resampleMono(input: Float32Array, inputRate: number, outputRate = TARGET_RATE): Float32Array {
  if (!Number.isFinite(inputRate) || inputRate <= 0) throw new Error('The microphone reported an invalid sample rate.')
  if (inputRate === outputRate) return input
  const outputLength = Math.max(1, Math.round(input.length * outputRate / inputRate))
  const output = new Float32Array(outputLength)
  const ratio = inputRate / outputRate

  if (ratio > 1) {
    for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
      const start = outputIndex * ratio
      const end = Math.min(input.length, (outputIndex + 1) * ratio)
      const first = Math.floor(start)
      const last = Math.ceil(end)
      let weighted = 0
      let weightTotal = 0
      for (let inputIndex = first; inputIndex < last; inputIndex += 1) {
        const weight = Math.max(0, Math.min(end, inputIndex + 1) - Math.max(start, inputIndex))
        weighted += (input[inputIndex] || 0) * weight
        weightTotal += weight
      }
      output[outputIndex] = weightTotal ? weighted / weightTotal : 0
    }
    return output
  }

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const position = outputIndex * ratio
    const before = Math.floor(position)
    const after = Math.min(input.length - 1, before + 1)
    const fraction = position - before
    output[outputIndex] = input[before] * (1 - fraction) + input[after] * fraction
  }
  return output
}

function captureErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'Microphone access is blocked. Allow Terry Tibbs in System Settings, then try again.'
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return 'No usable microphone was found. Connect or select a microphone, then try again.'
    if (error.name === 'NotReadableError' || error.name === 'AbortError') return 'The microphone is busy or unavailable. Close other audio apps and try again.'
  }
  return error instanceof Error && error.message ? `Microphone capture failed: ${error.message}` : 'Microphone capture failed. Check macOS permission and try again.'
}
