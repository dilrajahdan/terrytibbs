<template>
  <div class="microphone-settings">
    <div class="field">
      <label for="microphoneId">Microphone</label>
      <select
        id="microphoneId"
        :value="settings.microphoneId"
        :disabled="testing || requesting"
        @change="selectDevice"
      >
        <option value="">System default</option>
        <option v-if="selectedUnavailable" :value="settings.microphoneId">
          {{ settings.microphoneLabel || 'Saved microphone' }} (unavailable)
        </option>
        <option v-for="(device, index) in devices" :key="device.deviceId" :value="device.deviceId">
          {{ device.label || `Microphone ${index + 1}` }}
        </option>
      </select>
      <small v-if="devicesLoading" role="status">Looking for audio inputs…</small>
      <small v-else-if="devicesError" class="field-error" role="alert">{{ devicesError }}</small>
      <small v-else-if="selectedUnavailable" class="field-error">The saved microphone is disconnected. Reconnect it or choose another input. Terry will not silently fall back.</small>
      <small v-else>Choose a specific input for dependable daily dictation, or follow the macOS default.</small>
    </div>

    <div class="actual-input" :class="{ warning: displayWarning }" role="status" aria-live="polite">
      <span class="actual-input-dot" aria-hidden="true"></span>
      <span>
        <strong>{{ displayDevice ? `Actual input: ${displayDevice.label || 'Unnamed microphone'}` : requesting ? 'Opening the selected input' : 'Actual input not measured yet' }}</strong>
        <small v-if="displayDevice">{{ formatSampleRate(displayDevice.sampleRate) }} {{ !testDevice && prepared ? 'ready for dictation' : `during the latest ${testDevice ? 'input test' : 'dictation'}` }}</small>
        <small v-else>{{ requesting ? 'The previous input is hidden until this request resolves.' : 'Start a dictation or run the input test below.' }}</small>
        <small v-if="displayWarning" class="field-error">{{ displayWarning }}</small>
      </span>
    </div>

    <div class="input-test" :class="{ active: testing }">
      <div class="input-test-heading">
        <div>
          <strong>Test input</strong>
          <small>Listens for up to 10 seconds. Nothing is played, saved or transcribed.</small>
        </div>
        <span v-if="testing" class="mono">{{ secondsLeft }}s</span>
      </div>
      <div
        class="input-test-meter"
        role="meter"
        aria-label="Test microphone level"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="Math.round(meterPercent)"
      >
        <span :style="{ width: `${meterPercent}%` }"></span>
        <i aria-hidden="true"></i>
      </div>
      <div class="input-test-actions">
        <button v-if="testing || requesting" class="button secondary small" type="button" @click="stopTest('manual')">Stop test</button>
        <button v-else class="button secondary small" type="button" :disabled="busy || selectedUnavailable" @click="startTest">Test input</button>
        <button class="text-button" type="button" :disabled="testing || requesting" @click="refreshDevices">Refresh inputs</button>
      </div>
      <p v-if="testMessage" :class="['input-test-message', { error: testError }]" :role="testError ? 'alert' : 'status'">{{ testMessage }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { InputDevice, Settings } from '../../shared/types'

const props = defineProps<{
  settings: Settings
  inputDevice: InputDevice | null
  inputWarning: string
  prepared?: boolean
  phase: string
  busy: boolean
}>()

const emit = defineEmits<{
  update: [deviceId: string, label: string]
}>()

const devices = ref<MediaDeviceInfo[]>([])
const devicesLoading = ref(true)
const devicesError = ref('')
const requesting = ref(false)
const testing = ref(false)
const level = ref(0)
const secondsLeft = ref(10)
const testMessage = ref('')
const testError = ref(false)
const testDevice = ref<InputDevice | null>(null)
const suppressDictationDevice = ref(false)
let stream: MediaStream | null = null
let context: AudioContext | null = null
let source: MediaStreamAudioSourceNode | null = null
let analyser: AnalyserNode | null = null
let levelTimer: number | undefined
let stopTimer: number | undefined
let generation = 0
let startedAt = 0
let highestRms = 0
let clipped = false
let disposed = false

const selectedUnavailable = computed(() => !devicesLoading.value && !!props.settings.microphoneId && !devices.value.some(device => device.deviceId === props.settings.microphoneId))
const displayDevice = computed(() => testDevice.value || (!requesting.value && !suppressDictationDevice.value ? props.inputDevice : null))
const displayWarning = computed(() => testDevice.value || suppressDictationDevice.value ? '' : props.inputWarning)
const meterPercent = computed(() => {
  if (level.value <= 0) return 0
  const decibels = 20 * Math.log10(level.value)
  return Math.max(0, Math.min(100, ((decibels + 60) / 60) * 100))
})

function formatSampleRate(sampleRate: number): string {
  return sampleRate >= 1000 ? `${(sampleRate / 1000).toFixed(sampleRate % 1000 ? 1 : 0)} kHz` : `${sampleRate} Hz`
}

function selectDevice(event: Event): void {
  const deviceId = (event.target as HTMLSelectElement).value
  if (!deviceId) {
    testDevice.value = null
    emit('update', '', '')
    return
  }
  const device = devices.value.find(item => item.deviceId === deviceId)
  testDevice.value = null
  emit('update', deviceId, device?.label || props.settings.microphoneLabel || 'Selected microphone')
}

async function refreshDevices(): Promise<void> {
  devicesLoading.value = true
  devicesError.value = ''
  try {
    if (!navigator.mediaDevices?.enumerateDevices) throw new Error('Audio input discovery is unavailable in this app window.')
    const allDevices = await navigator.mediaDevices.enumerateDevices()
    devices.value = allDevices.filter(device => device.kind === 'audioinput')
    if (devices.value.length === 0) devicesError.value = 'No microphone inputs were found. Connect one, then refresh.'
  } catch (error) {
    devices.value = []
    devicesError.value = friendlyError(error, 'Microphone inputs could not be listed. Check macOS permission and try again.')
  } finally {
    devicesLoading.value = false
  }
}

async function startTest(): Promise<void> {
  stopTest('replace')
  window.dispatchEvent(new Event('terry-before-input-test'))
  const attempt = ++generation
  requesting.value = true
  suppressDictationDevice.value = true
  testError.value = false
  testMessage.value = `Opening ${props.settings.microphoneLabel || 'the system default microphone'}…`
  highestRms = 0
  clipped = false
  startedAt = performance.now()
  secondsLeft.value = 10
  stopTimer = window.setTimeout(() => stopTest('timeout'), 10_000)
  let pendingStream: MediaStream | null = null
  let pendingContext: AudioContext | null = null
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone testing is unavailable in this app window.')
    pendingStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(props.settings.microphoneId ? { deviceId: { exact: props.settings.microphoneId } } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    })
    if (disposed || attempt !== generation) {
      stopTracks(pendingStream)
      return
    }
    const track = pendingStream.getAudioTracks()[0]
    if (!track || track.readyState !== 'live') throw new Error('The selected microphone did not provide a live audio track.')
    // Stop/hide must close a live track even if AudioContext.resume stalls.
    stream = pendingStream
    pendingContext = new AudioContext({ latencyHint: 'interactive' })
    context = pendingContext
    await pendingContext.resume()
    if (disposed || attempt !== generation) {
      stopTracks(pendingStream)
      await pendingContext.close().catch(() => undefined)
      return
    }
    const pendingSource = pendingContext.createMediaStreamSource(pendingStream)
    const pendingAnalyser = pendingContext.createAnalyser()
    pendingAnalyser.fftSize = 2048
    pendingAnalyser.smoothingTimeConstant = 0.15
    pendingSource.connect(pendingAnalyser)
    const ended = () => {
      if (attempt !== generation) return
      stopTest('error', 'The selected microphone disconnected during the test.')
    }
    track.addEventListener('ended', ended, { once: true })
    stream = pendingStream
    context = pendingContext
    source = pendingSource
    analyser = pendingAnalyser
    requesting.value = false
    testing.value = true
    const trackSettings = track.getSettings()
    testDevice.value = {
      deviceId: trackSettings.deviceId || props.settings.microphoneId,
      label: track.label || props.settings.microphoneLabel || 'Selected microphone',
      sampleRate: trackSettings.sampleRate || pendingContext.sampleRate
    }
    suppressDictationDevice.value = false
    testMessage.value = `Listening to ${track.label || props.settings.microphoneLabel || 'the selected microphone'}…`
    const samples = new Float32Array(pendingAnalyser.fftSize)
    levelTimer = window.setInterval(() => {
      if (!analyser || attempt !== generation) return
      analyser.getFloatTimeDomainData(samples)
      let sumSquares = 0
      let peak = 0
      for (const sample of samples) {
        sumSquares += sample * sample
        peak = Math.max(peak, Math.abs(sample))
      }
      const rms = Math.sqrt(sumSquares / samples.length)
      level.value = rms
      highestRms = Math.max(highestRms, rms)
      clipped ||= peak >= 0.98
      const elapsed = performance.now() - startedAt
      secondsLeft.value = Math.max(0, 10 - Math.floor(elapsed / 1000))
      if (clipped) testMessage.value = 'The input is clipping. Lower the microphone input gain.'
      else if (highestRms >= 0.003) testMessage.value = 'Signal detected. This input is ready for dictation.'
      else if (elapsed >= 2500) testMessage.value = 'No clear signal detected yet. Speak closer or check the microphone input gain.'
    }, 100)
    await refreshDevices()
  } catch (error) {
    if (pendingStream) stopTracks(pendingStream)
    if (pendingContext) await pendingContext.close().catch(() => undefined)
    if (attempt !== generation || disposed) return
    clearResources()
    requesting.value = false
    testing.value = false
    testError.value = true
    testMessage.value = microphoneError(error)
    window.dispatchEvent(new Event('terry-after-input-test'))
  }
}

function stopTest(reason: 'manual' | 'timeout' | 'hide' | 'capture' | 'busy' | 'preview' | 'replace' | 'error', errorMessage = ''): void {
  const wasRequesting = requesting.value
  const wasTesting = testing.value || requesting.value
  if (wasTesting) queueMicrotask(() => { if (!testing.value && !requesting.value) window.dispatchEvent(new Event('terry-after-input-test')) })
  generation += 1
  clearResources()
  requesting.value = false
  testing.value = false
  level.value = 0
  if (!wasTesting && ['hide', 'capture', 'busy', 'preview', 'replace'].includes(reason)) return
  testError.value = reason === 'error'
  if (reason === 'error') testMessage.value = errorMessage || 'The microphone test stopped unexpectedly.'
  else if (reason === 'timeout') testMessage.value = wasRequesting ? 'The selected microphone did not open within 10 seconds. It is off.' : highestRms >= 0.003 ? '10 second test finished. The microphone is off.' : '10 second test finished without a clear signal. Check the selected input and its gain.'
  else if (reason === 'manual') testMessage.value = 'Input test stopped. The microphone is off.'
  else testMessage.value = ''
}

function clearResources(): void {
  if (levelTimer !== undefined) window.clearInterval(levelTimer)
  if (stopTimer !== undefined) window.clearTimeout(stopTimer)
  levelTimer = undefined
  stopTimer = undefined
  source?.disconnect()
  source = null
  analyser?.disconnect()
  analyser = null
  if (stream) stopTracks(stream)
  stream = null
  if (context) void context.close().catch(() => undefined)
  context = null
}

function stopTracks(value: MediaStream): void {
  for (const track of value.getTracks()) track.stop()
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') stopTest('hide')
}

function stopForHide(): void { stopTest('hide') }
function stopForCapture(): void { testDevice.value = null; suppressDictationDevice.value = true; stopTest('capture') }
function stopForPreview(): void { stopTest('preview') }

function microphoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'Microphone access is blocked. Allow Terry Tibbs in macOS Microphone settings, then try again.'
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return 'The selected microphone is unavailable. Reconnect it or choose another input.'
    if (error.name === 'NotReadableError' || error.name === 'AbortError') return 'The selected microphone is busy or unavailable. Close other audio apps and try again.'
  }
  return friendlyError(error, 'The microphone test could not start. Check the selected input and macOS permission.')
}

function friendlyError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

watch(() => props.busy, value => { if (value) stopTest('busy') })
watch(() => props.phase, value => {
  if (value === 'recording') {
    testDevice.value = null
    suppressDictationDevice.value = false
  }
})
watch(() => props.settings.microphoneId, () => {
  testDevice.value = null
  if (testing.value || requesting.value) stopTest('manual')
})

onMounted(() => {
  void refreshDevices()
  navigator.mediaDevices?.addEventListener('devicechange', refreshDevices)
  window.addEventListener('terry-before-hide', stopForHide)
  window.addEventListener('terry-before-capture', stopForCapture)
  window.addEventListener('terry-stop-input-test', stopForPreview)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  disposed = true
  stopTest('hide')
  navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices)
  window.removeEventListener('terry-before-hide', stopForHide)
  window.removeEventListener('terry-before-capture', stopForCapture)
  window.removeEventListener('terry-stop-input-test', stopForPreview)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

defineExpose({ stopTest: () => stopTest('preview') })
</script>
