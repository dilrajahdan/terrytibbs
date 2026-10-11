<template>
  <HudView v-if="isHud" :state="state" :load-error="loadError" />

  <main v-else class="app-shell">
    <header class="topbar">
      <a class="wordmark" href="#dictation" aria-label="Terry Tibbs home">
        <span class="wordmark-mark" aria-hidden="true">TT</span>
        <span>Terry Tibbs</span>
      </a>
      <div class="topbar-actions">
        <div class="privacy-chip"><span aria-hidden="true">●</span> On your Mac</div>
        <button class="close-button" type="button" @click="hideWindow">Close to menu bar</button>
      </div>
    </header>

    <nav class="tabs" aria-label="Main navigation">
      <button :class="{ active: tab === 'dictation' }" type="button" @click="tab = 'dictation'">Dictation</button>
      <button :class="{ active: tab === 'settings' }" type="button" @click="openSettings">Settings</button>
    </nav>

    <div v-if="!state" class="loading-card" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <div>
        <strong>Getting Terry ready</strong>
        <p>{{ loadError || 'Checking your local speech setup…' }}</p>
      </div>
      <button v-if="loadError" class="button secondary" type="button" @click="refreshState">Try again</button>
    </div>

    <template v-else>
      <p v-if="actionError" class="notice error" role="alert">{{ actionError }}</p>
      <section v-if="tab === 'dictation'" class="dictation-grid">
        <div class="talk-panel">
          <div>
            <p class="eyebrow">Private, local dictation</p>
            <h1>Talk to me.</h1>
            <p class="lede">Hold <kbd>{{ shortcutLabel }}</kbd> to talk and release to finish. Double-tap it to keep listening, then press once to stop.</p>
          </div>

          <div class="mic-stage" :class="[`phase-${state.phase}`, state.recordingMode ? `mode-${state.recordingMode}` : '']">
            <div class="mic-disc" aria-hidden="true">
              <svg viewBox="0 0 64 64" focusable="false">
                <rect x="23" y="9" width="18" height="32" rx="9" />
                <path d="M16 31a16 16 0 0 0 32 0M32 47v9M23 56h18" />
              </svg>
            </div>
            <AudioMeter :level="state.level" :active="state.phase === 'recording'" />
            <div class="phase-line" role="status" aria-live="polite">
              <span class="status-dot" aria-hidden="true"></span>
              <strong>{{ phaseTitle }}</strong>
              <span v-if="elapsedLabel" class="mono">{{ elapsedLabel }}</span>
            </div>
            <p class="phase-message">{{ !canRecord && !busy && state.phase !== 'error' ? 'Choose your local speech engine and model in Settings.' : (state.message || phaseDescription) }}</p>
          </div>

          <div v-if="state.inputDevice || state.inputWarning" class="dictation-input" :class="{ warning: state.inputWarning }" role="status">
            <span aria-hidden="true">{{ state.inputWarning ? '!' : '●' }}</span>
            <span>
              <strong v-if="state.inputDevice">Input: {{ state.inputDevice.label || 'Unnamed microphone' }}</strong>
              <small v-if="state.inputDevice">{{ formatSampleRate(state.inputDevice.sampleRate) }}</small>
              <small v-if="state.settings.keepMicrophoneReady && !busy">{{ state.microphoneReady ? 'Microphone ready for instant starts' : state.microphonePreparation || 'Preparing microphone…' }}</small>
              <small v-if="state.inputWarning">{{ state.inputWarning }}</small>
            </span>
          </div>

          <div class="primary-actions">
            <button v-if="state.phase === 'recording'" class="button primary stop" type="button" @click="run('toggle')">
              <span class="stop-icon" aria-hidden="true"></span> Stop dictation
            </button>
            <button v-else-if="!canRecord && !busy" class="button primary" type="button" @click="openSettings">Set up dictation</button>
            <button v-else class="button primary" type="button" :disabled="busy" @click="run('toggle')">
              <span class="mic-mini" aria-hidden="true">●</span>
              {{ busy ? busyButtonLabel : 'Start dictation' }}
            </button>
            <button v-if="state.phase !== 'ready' && state.phase !== 'error'" class="button ghost" type="button" @click="run('cancel')">Cancel</button>
          </div>
          <div class="utility-actions">
            <button class="text-button" type="button" :disabled="state.phase !== 'ready' && state.phase !== 'error'" @click="run('importAudio')">
              Import a WAV file <span aria-hidden="true">→</span>
            </button>
          </div>
          <p class="limit-note">Up to 2 minutes. Audio and transcripts stay in memory. Temporary WAV files are removed after processing.</p>
        </div>

        <aside class="side-stack">
          <SetupCard
            v-if="!state.engineReady || !state.modelReady"
            :state="state"
            @choose-engine="chooseFile('engine')"
            @choose-model="chooseFile('model')"
            @download-model="run('downloadModel')"
            @refresh="run('refresh')"
          />

          <section v-if="state.phase === 'error'" class="card error-card" role="alert">
            <div class="card-kicker">Needs attention</div>
            <h2>That one did not land.</h2>
            <p>{{ state.message || 'Dictation stopped before a transcript was created.' }}</p>
            <div class="inline-actions">
              <button v-if="state.canRetry" class="button small" type="button" @click="run('retry')">Retry audio</button>
              <button class="button small secondary" type="button" @click="run('refresh')">Check setup</button>
            </div>
          </section>

          <TranscriptCard v-if="state.transcript" :state="state" @copy="copyTranscript" @clear="run('clearTranscript')" @retry="run('retry')" />

          <section v-else class="card empty-card">
            <div class="empty-number">01</div>
            <h2>Your words appear here.</h2>
            <ol>
              <li>Hold <kbd>{{ shortcutLabel }}</kbd> and speak. Release it to finish.</li>
              <li>Double-tap the shortcut to lock. Press once when you are finished.</li>
              <li>Copy your transcript or let Terry paste it for you.</li>
            </ol>
          </section>

          <section v-if="state.microphone !== 'granted' || !state.accessibility || !state.shortcutReady" class="card permission-card">
            <div class="card-kicker">Mac permissions</div>
            <h2>Finish the handoff.</h2>
            <p v-if="state.microphone !== 'granted'">Microphone: {{ permissionLabel(state.microphone) }}</p>
            <p v-if="!state.shortcutReady">Keyboard shortcut: not ready. Allow Accessibility access, then check again.</p>
            <p v-if="!state.accessibility">Accessibility is off. The global shortcut and safe auto-paste need this permission.</p>
            <div class="inline-actions">
              <button v-if="state.microphone !== 'granted'" class="button small secondary" type="button" @click="openPermission('microphone')">Microphone settings</button>
              <button v-if="!state.accessibility" class="button small secondary" type="button" @click="openPermission('accessibility')">Accessibility settings</button>
            </div>
          </section>
        </aside>
      </section>

      <SettingsPanel
        v-else
        :state="state"
        :saving="saving"
        @save="saveSettings"
        @download-model="run('downloadModel')"
        @permission="openPermission"
        @refresh="run('refresh')"
      />
    </template>

    <footer class="footer">
      <span>Close the window anytime. Terry stays available from the microphone menu-bar icon.</span>
      <span class="mono">TERRY / LOCAL</span>
    </footer>
  </main>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { formatShortcut, shortcutFromKeyboardEvent } from '../shared/shortcut'
import type { ShortcutKeyboardEvent } from '../shared/shortcut'
import type { AppState, Settings, SoundClip } from '../shared/types'
import MicrophoneSettings from './components/MicrophoneSettings.vue'
import { createCaptureController } from './recorder'

const isHud = window.location.hash === '#hud' || window.location.hash === '#/hud'
const state = ref<AppState | null>(null)
const loadError = ref('')
const actionError = ref('')
const tab = ref<'dictation' | 'settings'>('dictation')
const elapsed = ref(0)
const saving = ref(false)
let unsubscribeState: (() => void) | undefined
let unsubscribeCapture: (() => void) | undefined
let unsubscribeOpenSettings: (() => void) | undefined
let captureController: ReturnType<typeof createCaptureController> | undefined
let clock: number | undefined

const shortcutLabel = computed(() => formatShortcut(state.value?.settings.shortcut || 'Option+Space'))
const busy = computed(() => !!state.value && ['starting', 'transcribing', 'cleaning'].includes(state.value.phase))
const canRecord = computed(() => !!state.value?.engineReady && !!state.value?.modelReady)
const busyButtonLabel = computed(() => {
  if (state.value?.phase === 'starting') return 'Getting ready…'
  if (state.value?.phase === 'transcribing') return 'Transcribing…'
  if (state.value?.phase === 'cleaning') return 'Tidying text…'
  return 'Working…'
})
const phaseTitle = computed(() => {
  if (!canRecord.value && state.value?.phase === 'ready') return 'Speech setup needed'
  if (state.value?.phase === 'recording') return state.value.recordingMode === 'locked' ? 'Listening, locked' : 'Listening while held'
  return ({ ready: 'Ready when you are', starting: 'Getting ready', transcribing: 'Writing it down', cleaning: 'Tidying your words', error: 'Dictation stopped' }[state.value?.phase || 'ready'])
})
const phaseDescription = computed(() => {
  if (state.value?.phase === 'recording') return state.value.recordingMode === 'locked' ? `Press ${shortcutLabel.value} once to stop.` : `Keep holding ${shortcutLabel.value}. Release to finish.`
  return ({ ready: 'Your microphone is idle.', starting: 'Waiting for macOS permission.', transcribing: 'Whisper is processing your audio on this Mac.', cleaning: 'Your local cleanup model is polishing the transcript.', error: 'Review the message and try again.' }[state.value?.phase || 'ready'])
})
const elapsedLabel = computed(() => state.value?.phase === 'recording' ? formatDuration(elapsed.value) : '')

function applyState(next: AppState): void {
  state.value = next
  syncMicrophonePreparation()
  if (next.phase !== 'error') actionError.value = ''
  updateElapsed()
}

let inputTestOwnsMicrophone = false
function syncMicrophonePreparation(): void {
  const current = state.value
  if (!captureController || !current || isHud) return
  captureController.prepare(current.settings.keepMicrophoneReady && ['granted', 'test device'].includes(current.microphone) && !current.inputSuspended && !inputTestOwnsMicrophone, current.settings.microphoneId)
}
function suspendMicrophonePreparation(): void { inputTestOwnsMicrophone = true; captureController?.suspend() }
function resumeMicrophonePreparation(): void { inputTestOwnsMicrophone = false; syncMicrophonePreparation() }

async function refreshState(): Promise<void> {
  loadError.value = ''
  try { applyState(await window.terry.getState()) }
  catch (error) { loadError.value = friendlyError(error, 'Terry could not read the local app state.') }
}

async function run(action: 'toggle' | 'cancel' | 'retry' | 'importAudio' | 'clearTranscript' | 'downloadModel' | 'refresh'): Promise<void> {
  actionError.value = ''
  try { await window.terry[action]() }
  catch (error) { actionError.value = friendlyError(error, 'That action could not be completed.') }
}

async function copyTranscript(raw = false): Promise<void> {
  actionError.value = ''
  try { await window.terry.copyTranscript(raw) }
  catch (error) { actionError.value = friendlyError(error, 'The transcript could not be copied.') }
}

async function chooseFile(kind: 'engine' | 'model'): Promise<void> {
  actionError.value = ''
  try {
    const path = await window.terry.chooseFile(kind)
    if (path && state.value) state.value = { ...state.value, settings: { ...state.value.settings, [kind === 'engine' ? 'whisperPath' : 'modelPath']: path } }
  } catch (error) { actionError.value = friendlyError(error, `The ${kind} file could not be selected.`) }
}

async function saveSettings(settings: Settings): Promise<void> {
  saving.value = true
  actionError.value = ''
  try { await window.terry.saveSettings(settings) }
  catch (error) { actionError.value = friendlyError(error, 'Settings could not be saved.') }
  finally { saving.value = false }
}

async function openPermission(kind: 'microphone' | 'accessibility'): Promise<void> {
  try { await window.terry.openPermission(kind) }
  catch (error) { actionError.value = friendlyError(error, `The ${kind} settings could not be opened.`) }
}

function openSettings(): void { tab.value = 'settings' }
async function hideWindow(): Promise<void> {
  actionError.value = ''
  window.dispatchEvent(new Event('terry-before-hide'))
  try { await window.terry.hideWindow() }
  catch (error) { actionError.value = friendlyError(error, 'Terry could not close to the menu bar.') }
}
function updateElapsed(): void { elapsed.value = state.value?.startedAt ? Math.max(0, Date.now() - state.value.startedAt) : 0 }
function formatDuration(ms: number): string { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }
function formatSampleRate(sampleRate: number): string { return sampleRate >= 1000 ? `${(sampleRate / 1000).toFixed(sampleRate % 1000 ? 1 : 0)} kHz` : `${sampleRate} Hz` }
function friendlyError(error: unknown, fallback: string): string { return error instanceof Error && error.message ? error.message : fallback }
function permissionLabel(value: string): string { return value === 'denied' ? 'blocked' : value === 'restricted' ? 'restricted' : 'not granted yet' }

onMounted(async () => {
  document.documentElement.classList.toggle('hud-root', isHud)
  document.body.classList.toggle('hud-body', isHud)
  let receivedUpdate = false
  unsubscribeState = window.terry.onState((next) => { receivedUpdate = true; applyState(next) })
  if (!isHud) {
    captureController = createCaptureController(window.terry)
    window.addEventListener('terry-before-input-test', suspendMicrophonePreparation)
    window.addEventListener('terry-after-input-test', resumeMicrophonePreparation)
    unsubscribeCapture = window.terry.onCapture((command) => {
      if (command.action === 'start') {
        window.dispatchEvent(new Event('terry-before-capture'))
        // End test ownership before promoting/opening capture, so its queued
        // completion cannot change preparation mode underneath this recording.
        resumeMicrophonePreparation()
      }
      if (command.action === 'cancel') window.dispatchEvent(new Event('terry-stop-input-test'))
      if (command.action === 'shutdown') {
        window.dispatchEvent(new Event('terry-stop-input-test'))
        captureController?.destroy()
      } else captureController?.handle(command)
    })
    unsubscribeOpenSettings = window.terry.onOpenSettings(async target => {
      tab.value = 'settings'
      if (target === 'shortcut') {
        await nextTick()
        const input = document.getElementById('shortcut')
        input?.scrollIntoView({ block: 'center' })
        input?.focus({ preventScroll: true })
      }
    })
  }
  try {
    const initial = await window.terry.getState()
    if (!receivedUpdate) applyState(initial)
  } catch (error) { loadError.value = friendlyError(error, 'Terry could not connect to the local app.') }
  clock = window.setInterval(updateElapsed, 250)
})

onBeforeUnmount(() => {
  unsubscribeState?.()
  unsubscribeCapture?.()
  unsubscribeOpenSettings?.()
  captureController?.destroy()
  window.removeEventListener('terry-before-input-test', suspendMicrophonePreparation)
  window.removeEventListener('terry-after-input-test', resumeMicrophonePreparation)
  if (clock !== undefined) window.clearInterval(clock)
  document.documentElement.classList.remove('hud-root')
  document.body.classList.remove('hud-body')
})

const AudioMeter = defineComponent({
  props: { level: { type: Number, required: true }, active: { type: Boolean, required: true }, compact: { type: Boolean, default: false } },
  setup(props) {
    const multipliers = [0.44, 0.68, 0.88, 1, 0.8, 0.58, 0.72, 0.48]
    return () => h('div', { class: ['audio-meter', { active: props.active }], role: 'meter', 'aria-label': 'Microphone level', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': Math.round(props.level * 100) }, multipliers.map((multiplier, index) => h('span', { key: index, style: { height: `${(props.compact ? 3 : 6) + Math.min(1, props.level * 5) * multiplier * (props.compact ? 13 : 34)}px` } })))
  }
})

const SetupCard = defineComponent({
  props: { state: { type: Object as () => AppState, required: true } },
  emits: ['choose-engine', 'choose-model', 'download-model', 'refresh'],
  setup(props, { emit }) { return () => h('section', { class: 'card setup-card' }, [
    h('div', { class: 'card-kicker' }, 'One-time setup'), h('h2', 'Give Terry his ears.'), h('p', 'Choose the local Whisper engine and model. Nothing is uploaded.'),
    h('div', { class: 'setup-list' }, [
      h('div', [h('span', { class: ['check', { done: props.state.engineReady }] }, props.state.engineReady ? '✓' : '1'), h('div', [h('strong', 'Whisper engine'), h('small', props.state.engineReady ? 'Ready' : 'Choose the whisper-cli file')]), !props.state.engineReady ? h('button', { class: 'text-button', type: 'button', onClick: () => emit('choose-engine') }, 'Choose') : null]),
      h('div', [h('span', { class: ['check', { done: props.state.modelReady }] }, props.state.modelReady ? '✓' : '2'), h('div', [h('strong', 'Speech model'), h('small', props.state.modelReady ? 'Ready' : 'Large v3 Turbo, downloaded separately')]), !props.state.modelReady ? h('button', { class: 'text-button', type: 'button', onClick: () => emit('download-model'), disabled: props.state.modelDownload !== null }, props.state.modelDownload !== null ? `${Math.round(props.state.modelDownload)}%` : 'Download') : null])
    ]),
    props.state.modelDownload !== null ? h('progress', { value: props.state.modelDownload, max: 100, 'aria-label': 'Model download progress' }, `${props.state.modelDownload}%`) : null,
    h('div', { class: 'inline-actions' }, [h('button', { class: 'button small secondary', type: 'button', onClick: () => emit('choose-model') }, 'Choose model file'), h('button', { class: 'button small ghost', type: 'button', onClick: () => emit('refresh') }, 'Check again')])
  ]) }
})

const TranscriptCard = defineComponent({
  props: { state: { type: Object as () => AppState, required: true } }, emits: ['copy', 'clear', 'retry'],
  setup(props, { emit }) { return () => { const transcript = props.state.transcript!; return h('section', { class: 'card transcript-card' }, [
    h('div', { class: 'transcript-heading' }, [h('div', [h('div', { class: 'card-kicker' }, 'Latest transcript'), h('h2', 'Fresh off the mic')]), h('button', { class: 'icon-button', type: 'button', title: 'Clear transcript', 'aria-label': 'Clear transcript', onClick: () => emit('clear') }, '×')]),
    h('blockquote', transcript.text),
    h('div', { class: 'transcript-meta mono' }, [h('span', `Audio ${formatDuration(transcript.durationMs)}`), h('span', `Processed ${(transcript.processingMs / 1000).toFixed(1)}s`)]),
    transcript.deliveryMessage ? h('p', { class: 'transcript-delivery', role: 'status' }, transcript.deliveryMessage) : null,
    h('div', { class: 'inline-actions' }, [h('button', { class: 'button small', type: 'button', onClick: () => emit('copy', false) }, 'Copy transcript'), h('button', { class: 'button small secondary', type: 'button', onClick: () => emit('copy', true) }, 'Copy raw'), props.state.canRetry ? h('button', { class: 'button small ghost', type: 'button', onClick: () => emit('retry') }, 'Retry') : null]),
    h('details', [h('summary', 'View raw transcription'), h('p', transcript.raw)])
  ]) } }
})

const ShortcutRecorder = defineComponent({
  props: { modelValue: { type: String, required: true } },
  emits: ['update:modelValue', 'recording-state'],
  setup(props, { emit }) {
    const mode = ref<'idle' | 'suspending' | 'listening' | 'confirm' | 'resuming'>('idle')
    const candidate = ref('')
    const recorderError = ref('')
    const panel = ref<HTMLElement | null>(null)
    const pressedModifiers = new Set<string>()
    let removeNativeListener: (() => void) | undefined
    let usedChordKey = false
    let suspended = false
    let disposed = false
    let attempt = 0

    watch(mode, value => emit('recording-state', value !== 'idle'), { immediate: true })

    function isModifier(event: KeyboardEvent): boolean {
      return ['Alt', 'Control', 'Meta', 'Shift', 'Fn'].includes(event.key) || /^(Alt|Control|Shift|Meta)(Left|Right)$/.test(event.code) || event.code === 'Fn'
    }
    function eventForShortcut(event: KeyboardEvent): ShortcutKeyboardEvent {
      return { key: event.key, code: event.code, location: event.location, repeat: event.repeat, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, getModifierState: event.getModifierState.bind(event), modifierCodes: [...pressedModifiers] }
    }
    function block(event: KeyboardEvent): void {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    function acceptCandidate(value: string): void {
      candidate.value = value
      mode.value = 'confirm'
      removeListeners()
      window.setTimeout(() => panel.value?.querySelector<HTMLButtonElement>('[data-confirm-shortcut]')?.focus(), 0)
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (mode.value !== 'listening') return
      block(event)
      if (event.repeat) return
      if (event.key === 'Escape') { void finish(false); return }
      if (isModifier(event)) {
        pressedModifiers.add(event.code || event.key)
        return
      }
      usedChordKey = true
      const value = shortcutFromKeyboardEvent(eventForShortcut(event))
      if (value) acceptCandidate(value)
      else {
        usedChordKey = false
        recorderError.value = 'That key needs Command, Control, Option or Shift. You can also use a function key by itself.'
      }
    }
    function onKeyUp(event: KeyboardEvent): void {
      if (mode.value !== 'listening') return
      block(event)
      if (!isModifier(event)) return
      if (!usedChordKey) {
        pressedModifiers.add(event.code || event.key)
        const value = shortcutFromKeyboardEvent(eventForShortcut(event))
        if (value) { acceptCandidate(value); return }
      }
      pressedModifiers.delete(event.code || event.key)
    }
    function addListeners(): void {
      removeNativeListener?.()
      removeNativeListener = window.terry.onShortcutCandidate(value => {
        if (mode.value === 'listening') acceptCandidate(value)
      })
      window.addEventListener('keydown', onKeyDown, true)
      window.addEventListener('keyup', onKeyUp, true)
    }
    function removeListeners(): void {
      removeNativeListener?.()
      removeNativeListener = undefined
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
    async function start(): Promise<void> {
      if (mode.value !== 'idle') return
      const thisAttempt = ++attempt
      recorderError.value = ''
      candidate.value = ''
      mode.value = 'suspending'
      try {
        await window.terry.suspendShortcut(true)
        suspended = true
        if (disposed || thisAttempt !== attempt) {
          await window.terry.suspendShortcut(false)
          suspended = false
          if (!disposed) mode.value = 'idle'
          return
        }
        mode.value = 'listening'
        usedChordKey = false
        pressedModifiers.clear()
        addListeners()
        window.setTimeout(() => panel.value?.focus(), 0)
      } catch (error) {
        mode.value = 'idle'
        recorderError.value = friendlyError(error, 'The global shortcut could not be paused for recording.')
        void window.terry.suspendShortcut(false)
      }
    }
    function tryAgain(): void {
      candidate.value = ''
      usedChordKey = false
      pressedModifiers.clear()
      mode.value = 'listening'
      addListeners()
      window.setTimeout(() => panel.value?.focus(), 0)
    }
    async function finish(useCandidate: boolean): Promise<void> {
      const suspensionIsPending = mode.value === 'suspending'
      ++attempt
      removeListeners()
      pressedModifiers.clear()
      if (useCandidate && candidate.value) emit('update:modelValue', candidate.value)
      candidate.value = ''
      mode.value = suspended || suspensionIsPending ? 'resuming' : 'idle'
      if (suspended) {
        try { await window.terry.suspendShortcut(false) }
        catch (error) { recorderError.value = friendlyError(error, 'The global shortcut could not be resumed. Reopen Terry before dictating.') }
        finally { suspended = false; mode.value = 'idle' }
      }
    }
    async function selectGlobe(): Promise<void> {
      recorderError.value = ''
      await finish(false)
      if (!disposed) emit('update:modelValue', 'Fn')
    }
    function cancelForWindowChange(): void {
      if (['suspending', 'listening', 'confirm'].includes(mode.value)) void finish(false)
    }
    function cancelWhenHidden(): void {
      if (document.visibilityState === 'hidden') cancelForWindowChange()
    }
    onMounted(() => {
      window.addEventListener('blur', cancelForWindowChange)
      window.addEventListener('terry-before-hide', cancelForWindowChange)
      document.addEventListener('visibilitychange', cancelWhenHidden)
    })
    onBeforeUnmount(() => {
      disposed = true
      ++attempt
      removeListeners()
      window.removeEventListener('blur', cancelForWindowChange)
      window.removeEventListener('terry-before-hide', cancelForWindowChange)
      document.removeEventListener('visibilitychange', cancelWhenHidden)
      if (suspended) void window.terry.suspendShortcut(false).finally(() => { suspended = false })
    })
    return () => h('div', { class: 'shortcut-recorder' }, [
      h('div', { class: 'shortcut-current' }, [h('input', { id: 'shortcut', class: 'shortcut-manual mono', value: props.modelValue, disabled: mode.value !== 'idle', spellcheck: false, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value) }), h('button', { class: 'button secondary small', type: 'button', disabled: mode.value !== 'idle', onClick: () => void start() }, mode.value === 'suspending' ? 'Pausing shortcut…' : mode.value === 'resuming' ? 'Resuming shortcut…' : 'Record shortcut')]),
      h('div', { class: 'globe-shortcut' }, [
        h('button', { class: 'button secondary small', type: 'button', disabled: ['suspending', 'resuming'].includes(mode.value), onClick: () => void selectGlobe() }, 'Use Globe / Fn'),
        h('small', props.modelValue === 'Fn' ? 'Globe / Fn selected. Save settings to apply it.' : 'For the Mac Globe key, choose it here. It may not appear when you record a key.')
      ]),
      mode.value !== 'idle' ? h('div', { ref: panel, class: 'shortcut-capture', tabindex: -1, role: 'group', 'aria-label': 'Record global shortcut' }, mode.value === 'confirm' ? [
        h('span', { class: 'capture-label' }, 'Use this shortcut?'),
        h('kbd', formatShortcut(candidate.value)),
        h('div', { class: 'inline-actions' }, [
          h('button', { class: 'button small', type: 'button', 'data-confirm-shortcut': '', onClick: () => void finish(true) }, 'Use shortcut'),
          h('button', { class: 'button small secondary', type: 'button', onClick: tryAgain }, 'Try again'),
          h('button', { class: 'button small ghost', type: 'button', onClick: () => void finish(false) }, 'Cancel')
        ])
      ] : [
        h('strong', mode.value === 'suspending' ? 'Pausing the current shortcut…' : mode.value === 'resuming' ? 'Resuming the global shortcut…' : 'Press your shortcut now'),
        h('small', ['suspending', 'resuming'].includes(mode.value) ? 'This will only take a moment.' : 'Use a modifier with letters, numbers or Space. Function keys and a left or right modifier can be used alone. Press Esc to cancel.')
      ]) : null,
      recorderError.value ? h('small', { class: 'field-error', role: 'alert' }, recorderError.value) : null
    ])
  }
})

const SettingsPanel = defineComponent({
  props: { state: { type: Object as () => AppState, required: true }, saving: { type: Boolean, required: true } }, emits: ['save', 'download-model', 'permission', 'refresh'],
  setup(props, { emit }) {
    const draft = reactive<Settings>({ ...props.state.settings })
    const fileError = ref('')
    const previewing = ref(false)
    const soundMessage = ref('')
    const soundClips = ref<SoundClip[]>([])
    const clipsLoading = ref(false)
    const clipsError = ref('')
    async function loadSoundClips(): Promise<void> {
      soundClips.value = []
      clipsError.value = ''
      if (!draft.activationSoundDirectory) return
      clipsLoading.value = true
      try { soundClips.value = await window.terry.listSoundClips({ ...draft }) }
      catch (error) { clipsError.value = friendlyError(error, 'Voice clips could not be listed. Check the selected folder.') }
      finally { clipsLoading.value = false }
    }
    async function previewSound(): Promise<void> {
      window.dispatchEvent(new Event('terry-stop-input-test'))
      previewing.value = true
      soundMessage.value = ''
      try { const result = await window.terry.previewSound({ ...draft }); soundMessage.value = result.warning || (result.played ? 'Preview finished. Recording has not started.' : '') }
      catch (error) { soundMessage.value = friendlyError(error, 'The sound could not be played.') }
      finally { previewing.value = false }
    }
    const shortcutRecorderActive = ref(false)
    watch(() => settingsSignature(props.state.settings), (signature, previousSignature) => {
      if (signature !== previousSignature) {
        Object.assign(draft, props.state.settings)
        void loadSoundClips()
      }
    })
    async function pickFile(kind: 'engine' | 'model' | 'sounds'): Promise<void> {
      fileError.value = ''
      try {
        const path = await window.terry.chooseFile(kind)
        if (path && kind === 'sounds') {
          draft.activationSoundDirectory = path
          draft.activationSoundClip = ''
          await loadSoundClips()
        } else if (path) draft[kind === 'engine' ? 'whisperPath' : 'modelPath'] = path
      } catch (error) {
        fileError.value = friendlyError(error, `The ${kind} file could not be selected.`)
      }
    }
    const hasTurboModel = () => draft.modelPath.toLowerCase().includes('large-v3-turbo')
    const selectedClipUnavailable = () => !!draft.activationSoundClip && !soundClips.value.some(clip => clip.name === draft.activationSoundClip)
    const previewLabel = () => draft.activationSound === 'buzz' ? 'Preview quick buzz' : draft.activationSound === 'chime' ? 'Preview Mac chime' : draft.activationSoundClip ? 'Preview selected clip' : 'Preview next clip'
    onMounted(() => { void loadSoundClips() })
    return () => h('section', { class: 'settings-page' }, [
      h('div', { class: 'settings-intro' }, [h('p', { class: 'eyebrow' }, 'Make it yours'), h('h1', 'Settings'), h('p', { class: 'lede' }, 'All paths and preferences stay on this Mac.')]),
      h('form', { class: 'settings-form', onSubmit: (event: Event) => { event.preventDefault(); if (!shortcutRecorderActive.value) { window.dispatchEvent(new Event('terry-stop-input-test')); emit('save', { ...draft }) } } }, [
        fileError.value ? h('p', { class: 'notice error', role: 'alert' }, fileError.value) : null,
        h('section', { class: 'settings-section' }, [h('div', [h('span', { class: 'section-number' }, '01'), h('h2', 'Speech engine'), h('p', 'Point Terry at your local whisper.cpp command and model.')]), h('div', { class: 'fields' }, [
          field('Whisper command', h('div', { class: 'path-row' }, [h('input', { id: 'whisperPath', value: draft.whisperPath, readonly: true, placeholder: 'Choose whisper-cli…' }), h('button', { class: 'button secondary', type: 'button', onClick: () => void pickFile('engine') }, 'Choose')]), props.state.engineReady ? 'Engine ready.' : 'Required before recording.', 'whisperPath'),
          field('Model file', h('div', { class: 'path-row' }, [h('input', { id: 'modelPath', value: draft.modelPath, readonly: true, placeholder: 'Choose a .bin model…' }), h('button', { class: 'button secondary', type: 'button', onClick: () => void pickFile('model') }, 'Choose')]), props.state.modelReady ? 'Model ready.' : 'Large v3 Turbo is recommended.', 'modelPath'),
          props.state.modelDownload !== null ? h('div', { class: 'download-row' }, [h('progress', { value: props.state.modelDownload, max: 100 }), h('span', `${Math.round(props.state.modelDownload)}% downloaded`)]) : h('button', { class: 'text-button align-left', type: 'button', disabled: hasTurboModel(), onClick: () => emit('download-model') }, hasTurboModel() ? 'Large v3 Turbo installed' : props.state.modelReady ? 'Download Large v3 Turbo →' : 'Download recommended model →'),
          field('Language', h('select', { id: 'language', value: draft.language, onChange: (event: Event) => draft.language = (event.target as HTMLSelectElement).value }, [h('option', { value: 'en' }, 'English'), h('option', { value: 'auto' }, 'Detect automatically')]))
        ])]),
        h('section', { class: 'settings-section' }, [h('div', [h('span', { class: 'section-number' }, '02'), h('h2', 'How you dictate'), h('p', 'Hold your shortcut to talk. Release to finish, or double-tap to lock the microphone on. The start button begins a locked recording.')]), h('div', { class: 'fields' }, [
          field('Global shortcut', h(ShortcutRecorder, { modelValue: draft.shortcut, 'onUpdate:modelValue': (value: string) => { draft.shortcut = value }, onRecordingState: (active: boolean) => { shortcutRecorderActive.value = active } }), props.state.shortcutReady ? 'Record a real key or combination, then save. You can also type the shortcut.' : 'Shortcut listener is not ready. Allow Accessibility access, then check permissions again.', 'shortcut'),
          h(MicrophoneSettings, { settings: draft, inputDevice: props.state.inputDevice, inputWarning: props.state.inputWarning, prepared: props.state.microphoneReady && props.state.settings.keepMicrophoneReady, phase: props.state.phase, busy: ['starting', 'recording', 'transcribing', 'cleaning'].includes(props.state.phase), onUpdate: (deviceId: string, label: string) => { draft.microphoneId = deviceId; draft.microphoneLabel = label } }),
          toggle('keepMicrophoneReady', 'Keep microphone ready', 'Instant starts. Keeps the mic active with only the latest 120 ms in memory. Discarded outside dictation; pauses on lock or sleep.', () => draft.keepMicrophoneReady, value => draft.keepMicrophoneReady = value),
          h('p', { role: 'status' }, props.state.microphonePreparation || (draft.keepMicrophoneReady ? 'Save to prepare the microphone.' : 'Microphone opens when you press the shortcut.')),
          toggle('muteOtherAudio', 'Mute other audio while dictating', 'Terry’s clip still plays. Other audio returns when recording ends.', () => draft.muteOtherAudio, value => draft.muteOtherAudio = value),
          field('Activation sound', h('select', { id: 'activationSound', value: draft.activationSound, onChange: (event: Event) => { draft.activationSound = (event.target as HTMLSelectElement).value as Settings['activationSound']; soundMessage.value = ''; if (draft.activationSound === 'clips') void loadSoundClips() } }, [h('option', { value: 'off' }, 'Off'), h('option', { value: 'buzz' }, 'Quick buzz'), h('option', { value: 'chime' }, 'Mac chime'), h('option', { value: 'clips' }, 'Terry voice')]), draft.activationSound === 'buzz' || draft.activationSound === 'off' ? 'Capture starts with your shortcut. The short buzz does not hold up recording.' : 'Voice clips and Mac chime delay recording until playback finishes. Choose Quick buzz for a fast start.'),
          draft.activationSound === 'clips' ? field('Voice clips folder', h('div', { class: 'path-row' }, [h('input', { id: 'activationSoundDirectory', value: draft.activationSoundDirectory, readonly: true, placeholder: 'Choose your clips folder…' }), h('button', { class: 'button secondary', type: 'button', onClick: () => void pickFile('sounds') }, 'Choose folder…')]), 'One clip per activation, in filename order. MP3, WAV, M4A, AIFF or CAF.', 'activationSoundDirectory') : null,
          draft.activationSound === 'clips' && draft.activationSoundDirectory ? field('Voice clip', h('select', { id: 'activationSoundClip', value: draft.activationSoundClip, disabled: clipsLoading.value, onChange: (event: Event) => { draft.activationSoundClip = (event.target as HTMLSelectElement).value; soundMessage.value = '' } }, [h('option', { value: '' }, 'Rotate all clips'), selectedClipUnavailable() ? h('option', { value: draft.activationSoundClip }, `${draft.activationSoundClip} (unavailable)`) : null, ...soundClips.value.map(clip => h('option', { value: clip.name }, clip.label))]), clipsLoading.value ? 'Loading clips…' : clipsError.value || (soundClips.value.length ? 'Choose one local clip or rotate through every clip in the folder.' : 'No supported clips found in this folder.')) : null,
          draft.activationSound !== 'off' ? h('div', { class: 'sound-preview' }, [h('button', { class: 'button secondary small', type: 'button', disabled: previewing.value || clipsLoading.value || (draft.activationSound === 'clips' && !draft.activationSoundDirectory) || ['starting', 'recording', 'transcribing', 'cleaning'].includes(props.state.phase), onClick: () => void previewSound() }, previewing.value ? 'Playing…' : previewLabel()), soundMessage.value ? h('small', { role: 'status' }, soundMessage.value) : null]) : null,
          field('Vocabulary', h('textarea', { id: 'vocabulary', value: draft.vocabulary, rows: 4, placeholder: 'Alex, Example Studio, product names…', onInput: (event: Event) => draft.vocabulary = (event.target as HTMLTextAreaElement).value }), 'Comma-separated words and phrases Whisper should expect.'),
          toggle('autoPaste', 'Paste automatically', 'Paste only when the app you started in is still focused.', () => draft.autoPaste, (value) => draft.autoPaste = value)
        ])]),
        h('section', { class: 'settings-section' }, [h('div', [h('span', { class: 'section-number' }, '03'), h('h2', 'Local cleanup'), h('p', 'Optionally tidy punctuation with Ollama on this Mac.')]), h('div', { class: 'fields' }, [
          toggle('cleanupEnabled', 'Clean up my transcript', 'Raw text is always kept if cleanup fails.', () => draft.cleanupEnabled, (value) => draft.cleanupEnabled = value),
          field('Ollama model', h('select', { id: 'cleanupModel', value: draft.cleanupModel, disabled: !draft.cleanupEnabled, onChange: (event: Event) => draft.cleanupModel = (event.target as HTMLSelectElement).value }, [h('option', { value: '' }, 'Choose a local model'), draft.cleanupModel && !props.state.localModels.includes(draft.cleanupModel) ? h('option', { value: draft.cleanupModel }, draft.cleanupModel) : null, ...props.state.localModels.map(model => h('option', { value: model }, model)), props.state.localModels.length === 0 ? h('option', { value: '__none', disabled: true }, 'No local models installed') : null]), 'Only locally installed models are shown.')
        ])]),
        h('section', { class: 'settings-section permissions-settings' }, [h('div', [h('span', { class: 'section-number' }, '04'), h('h2', 'Mac permissions'), h('p', 'Microphone records audio. Accessibility enables the global hold shortcut and safe auto-paste.')]), h('div', { class: 'permission-list fields' }, [
          permissionRow('Microphone', props.state.microphone === 'granted' ? 'Allowed' : permissionLabel(props.state.microphone), props.state.microphone === 'granted', () => emit('permission', 'microphone')),
          permissionRow('Accessibility', props.state.accessibility ? 'Allowed' : 'Not allowed', props.state.accessibility, () => emit('permission', 'accessibility')),
          h('div', { class: 'permission-row' }, [h('span', { class: ['check', { done: props.state.shortcutReady }] }, props.state.shortcutReady ? '✓' : '!'), h('div', [h('strong', 'Keyboard shortcut'), h('small', props.state.shortcutReady ? 'Listening in the menu bar' : 'Not ready. Review Accessibility, then check again.')])]),
          h('button', { class: 'text-button align-left', type: 'button', onClick: () => emit('refresh') }, 'Check permissions again →')
        ])]),
        h('div', { class: 'save-bar' }, [h('p', shortcutRecorderActive.value ? 'Use or cancel the recorded shortcut before saving.' : (props.state.message || 'Closing this window keeps Terry available from the TT menu-bar icon.')), h('button', { class: 'button primary', type: 'submit', disabled: props.saving || shortcutRecorderActive.value }, props.saving ? 'Saving…' : 'Save settings')])
      ])
    ])
  }
})

const HudView = defineComponent({
  props: { state: { type: Object as () => AppState | null, default: null }, loadError: { type: String, default: '' } },
  setup(props) {
    const title = () => {
      if (props.loadError) return props.loadError
      if (props.state?.phase === 'starting' && props.state.recordingMode === 'locked') return 'Locked, getting ready'
      if (props.state?.phase === 'recording') return props.state.recordingMode === 'locked' ? 'Listening, locked' : 'Listening while held'
      if (props.state?.phase === 'ready' && props.state.delivery === 'none') return 'No speech'
      if (props.state?.phase === 'ready' && ['sent', 'clipboard'].includes(props.state.delivery || '')) return props.state.delivery === 'sent' ? 'Paste sent' : 'Copied only'
      return ({ starting: 'Getting ready', transcribing: 'Transcribing', cleaning: 'Tidying text', error: 'Needs attention', ready: 'Ready' }[props.state?.phase || 'ready'])
    }
    const detail = () => {
      if (props.state?.phase === 'recording' && props.state.inputWarning) return props.state.inputWarning
      if (props.state?.phase === 'recording') return props.state.recordingMode === 'locked' ? 'Press shortcut to finish' : 'Release to finish'
      if (props.state?.phase === 'ready' && props.state.transcript) return props.state.message || 'Transcript is on your clipboard'
      return props.state?.message || 'Terry Tibbs'
    }
    return () => {
      const phase = props.state?.phase || 'ready'
      const recording = phase === 'recording'
      const locked = props.state?.recordingMode === 'locked'
      const waiting = ['starting', 'transcribing', 'cleaning'].includes(phase)
      const problem = phase === 'error' || !!props.loadError
      const result = props.state?.delivery === 'none' ? 'No speech' : props.state?.delivery === 'sent' ? 'Sent' : props.state?.delivery === 'clipboard' ? 'Copied' : 'Ready'
      return h('div', { class: ['hud', `phase-${phase}`, { 'mode-locked': locked }], role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, [
        h('span', { class: 'sr-only' }, `${title()}. ${detail()}`),
        h('div', { class: 'hud-visual', 'aria-hidden': 'true' }, [
          locked && (phase === 'starting' || recording)
            ? h('svg', { class: 'hud-lock', viewBox: '0 0 12 14', fill: 'none' }, [h('rect', { x: 1.5, y: 6, width: 9, height: 6.5, rx: 1.5 }), h('path', { d: 'M3.5 6V3.5a2.5 2.5 0 0 1 5 0V6' })])
            : null,
          ...(recording ? [
            props.state?.inputWarning ? h('span', { class: 'hud-warning', title: props.state.inputWarning }, '!') : !locked ? h('span', { class: 'hud-dot' }) : null,
            h(AudioMeter, { level: props.state?.level || 0, active: true, compact: true })
          ] : waiting ? [
            h('span', { class: 'hud-busy' }, [h('i'), h('i'), h('i')])
          ] : [
          h('span', { class: ['hud-result-icon', { problem }] }, problem ? '!' : props.state?.delivery === 'none' ? '·' : '✓'),
          h('span', { class: 'hud-result' }, problem ? 'Check' : result)
          ])
        ])
      ])
    }
  }
})

function field(label: string, control: ReturnType<typeof h>, help = '', explicitId?: string) { const id = explicitId || control.props?.id as string | undefined; return h('div', { class: 'field' }, [h('label', { for: id }, label), control, help ? h('small', help) : null]) }
function toggle(id: string, label: string, help: string, get: () => boolean, set: (value: boolean) => void) { return h('label', { class: 'toggle', for: id }, [h('input', { id, type: 'checkbox', checked: get(), onChange: (event: Event) => set((event.target as HTMLInputElement).checked) }), h('span', { class: 'toggle-track', 'aria-hidden': 'true' }), h('span', [h('strong', label), h('small', help)])]) }
function permissionRow(label: string, detail: string, ready: boolean, open: () => void) { return h('div', { class: 'permission-row' }, [h('span', { class: ['check', { done: ready }] }, ready ? '✓' : '!'), h('div', [h('strong', label), h('small', detail)]), h('button', { class: 'button secondary small', type: 'button', onClick: open }, ready ? 'Review' : 'Open settings')]) }
function settingsSignature(settings: Settings): string { return JSON.stringify([settings.whisperPath, settings.modelPath, settings.shortcut, settings.language, settings.vocabulary, settings.autoPaste, settings.muteOtherAudio, settings.keepMicrophoneReady, settings.cleanupEnabled, settings.cleanupModel, settings.activationSound, settings.activationSoundDirectory, settings.activationSoundClip, settings.microphoneId, settings.microphoneLabel]) }
</script>

<style src="./styles/main.css"></style>
