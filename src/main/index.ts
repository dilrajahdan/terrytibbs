import { NoSpeechError, requireSpeech, VAD_MODEL_NAME } from './voice-activity'
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, screen, session, shell, systemPreferences, Tray } from 'electron'
import { mkdirSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { AppState, CaptureCommand, Settings } from '../shared/types'
import { engineExists, loadSettings, modelExists, persistSettings, validateSettings } from './settings'
import { MODEL_NAME, downloadModelFile } from './model'
import { cleanTranscript, listLocalModels, pcmToWav, transcribeWav, validateWav } from './speech'
import { warmWhisperServer, stopWhisperServer, type WhisperServerHandle } from './whisper-server'
import { frontmost, pasteTranscript, requestAccessibility, type FrontApp } from './native'
import { ActivationSounds, availableSoundClips } from './sounds'
import { WarmAudioService, type AudioLease } from './warm-audio'
import { ShortcutGesture } from './gesture'
import { createHotkeyMonitor, type HotkeyEvent } from './hotkey'
import { formatShortcut, parseShortcut } from '../shared/shortcut'
import { applyCorrections, suggestCorrections, validateCorrections } from '../shared/corrections'

const e2e = !app.isPackaged && process.env.TERRY_E2E === '1'
if (e2e && process.env.TERRY_USER_DATA) app.setPath('userData', process.env.TERRY_USER_DATA)
else app.setPath('userData', join(app.getPath('appData'), 'Terry Tibbs'))
app.setName('Terry Tibbs')
let main: BrowserWindow
const HUD_WIDTH = 112
const HUD_HEIGHT = 36
let hud: BrowserWindow
let tray: Tray
let trayIconAvailable = false
let trayMenu: Menu
let quitting = false
let screenLocked = false
let systemSuspended = false
let state: AppState
let activeId = 0
let completedCaptureId = -1
let operation: AbortController | null = null
let download: AbortController | null = null
let captureTimer: ReturnType<typeof setTimeout> | null = null
let lastAudio: Buffer | null = null
let destinationWork: Promise<FrontApp | null> = Promise.resolve(null)
let helper = ''
let monitor: ReturnType<typeof createHotkeyMonitor> | null = null
let monitorGeneration = 0
let shortcutSuspended = false
let shortcutTransition: Promise<void> = Promise.resolve()
let traySignature = ''
let hudTimer: ReturnType<typeof setTimeout> | null = null
const activationSounds = new ActivationSounds(e2e ? process.env.TERRY_TEST_SOUND_PLAYER : undefined)
let previewController: AbortController | null = null
let previewWork: Promise<{ played: boolean; warning?: string }> | null = null
let cueWork: Promise<{ played: boolean; warning?: string }> | null = null
let cueWarning = ''
let audioService: WarmAudioService | null = null
let audioLeaseWork: Promise<AudioLease> | null = null
let audioLeaseService: WarmAudioService | null = null
let audioRestoreWork: Promise<void> = Promise.resolve()
let stopAfterStartId = -1
function getAudioService(): WarmAudioService {
  if (!audioService?.running) {
    if (e2e && !process.env.TERRY_E2E_AUDIO_HELPER) throw new Error('Background audio requires the isolated test helper in E2E mode.')
    const executable = app.isPackaged ? join(process.resourcesPath, 'terry-audio') : (e2e && process.env.TERRY_E2E_AUDIO_HELPER) || resolve(__dirname, '../../build/terry-audio')
    audioService = new WarmAudioService(executable)
    void audioService.ready.catch(() => undefined)
  }
  return audioService
}
function prepareBackgroundAudio(): void {
  if (quitting || (e2e && !process.env.TERRY_E2E_AUDIO_HELPER)) return
  if (state.settings.muteOtherAudio || state.settings.activationSound === 'buzz') void getAudioService().ready.catch(() => undefined)
  else { const previous = audioService; audioService = null; void previous?.stop() }
}
function releaseBackgroundAudio(): Promise<void> {
  const lease = audioLeaseWork
  const owner = audioLeaseService
  audioLeaseWork = null
  audioLeaseService = null
  const release = lease?.then(value => value.stop()).catch(() => undefined).then(async () => {
    await owner?.idle
    if (owner && !owner.running) await owner.closed
  })
  audioRestoreWork = Promise.all([audioRestoreWork, release]).then(() => undefined)
  return audioRestoreWork
}
let warmEngine: { key: string; controller: AbortController; ready: Promise<WhisperServerHandle | undefined>; handle?: WhisperServerHandle } | null = null
function prepareSpeechEngine(settings: Settings): Promise<WhisperServerHandle | undefined> {
  if (quitting || !engineExists(settings.whisperPath) || !modelExists(settings.modelPath)) return Promise.resolve(undefined)
  const key = JSON.stringify([settings.whisperPath, settings.modelPath])
  if (warmEngine?.key === key && (!warmEngine.handle || warmEngine.handle.running)) return warmEngine.ready
  const previous = warmEngine
  previous?.controller.abort()
  if (previous) void previous.ready.then(handle => stopWhisperServer(handle)).catch(() => undefined)
  const controller = new AbortController()
  const entry: NonNullable<typeof warmEngine> = { key, controller, ready: Promise.resolve(undefined) }
  warmEngine = entry
  entry.ready = warmWhisperServer({ executable: join(dirname(settings.whisperPath), 'whisper-server'), modelPath: settings.modelPath, signal: controller.signal })
    .then(async handle => {
      if (controller.signal.aborted || quitting || warmEngine !== entry) { await handle.stop(); return undefined }
      entry.handle = handle
      return handle
    }).catch(() => undefined)
  return entry.ready
}

const gesture = new ShortcutGesture({
  canStart: () => !!state && !quitting && !isBusy() && !shortcutSuspended && !state.inputSuspended,
  start: () => { void startRecording() },
  stop: stopRecording,
  mode: recordingMode => { if (state) setState({ recordingMode, ...(state.phase === 'recording' ? { message: recordingMode === 'locked' ? 'Listening locked. Press your shortcut to finish.' : 'Listening. Release your shortcut to finish.' } : {}) }) }
})
const isBusy = () => ['starting', 'recording', 'transcribing', 'cleaning'].includes(state.phase)
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please retry.'

function broadcast() {
  for (const win of [main, hud]) if (win && !win.isDestroyed()) win.webContents.send('terry:state', state)
  updateTray()
}
function setState(patch: Partial<AppState>) { state = { ...state, ...patch }; broadcast() }
function capture(command: CaptureCommand) { if (main && !main.isDestroyed()) main.webContents.send('terry:capture', command) }
function clearCaptureTimer() { if (captureTimer) clearTimeout(captureTimer); captureTimer = null }
function releaseEscape() { if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape') }
function hideHud() { if (hudTimer) clearTimeout(hudTimer); hudTimer = null; if (hud && !hud.isDestroyed()) hud.hide() }
function showHud() {
  if (hudTimer) clearTimeout(hudTimer); hudTimer = null
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  hud.setPosition(Math.round(area.x + (area.width - HUD_WIDTH) / 2), area.y + area.height - HUD_HEIGHT - 8)
  hud.showInactive()
}
function fail(error: unknown, id = activeId) {
  if (id !== activeId) return
  gesture.reset()
  clearCaptureTimer(); releaseEscape(); hideHud()
  capture({ action: 'cancel', sessionId: id })
  operation?.abort(); operation = null
  void releaseBackgroundAudio()
  if (error instanceof NoSpeechError) lastAudio = null
  setState({ phase: error instanceof NoSpeechError ? 'ready' : 'error', delivery: error instanceof NoSpeechError ? 'none' : state.delivery, level: 0, startedAt: null, inputWarning: '', message: errorText(error), canRetry: !!lastAudio })
  if (!main.isVisible()) { showHud(); hudTimer = setTimeout(hideHud, 7000) }
}
function cancel() {
  gesture.reset()
  const id = activeId
  activeId++
  operation?.abort(); operation = null
  void releaseBackgroundAudio()
  clearCaptureTimer(); releaseEscape(); hideHud()
  capture({ action: 'cancel', sessionId: id })
  setState({ phase: 'ready', level: 0, startedAt: null, inputWarning: '', message: 'Cancelled. Ready when you are.', canRetry: !!lastAudio })
}
async function refresh() {
  const microphone = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'unsupported'
  const native = e2e ? null : await frontmost(helper).catch(() => null)
  setState({ engineReady: engineExists(state.settings.whisperPath), modelReady: modelExists(state.settings.modelPath), microphone, accessibility: native?.trusted ?? false, localModels: await listLocalModels() })
  if (!e2e && native?.trusted && !state.shortcutReady && !shortcutSuspended) startMonitor()
}
function assertEngine() {
  if (!engineExists(state.settings.whisperPath)) throw new Error('Whisper is missing. Install whisper-cpp with Homebrew, then choose whisper-cli in Settings.')
  if (!modelExists(state.settings.modelPath)) throw new Error('Choose a speech model or download Whisper Turbo in Settings.')
}
function stopRecording() {
  gesture.reset()
  if (state.phase === 'starting' && state.settings.keepMicrophoneReady && ['buzz', 'off'].includes(state.settings.activationSound)) {
    stopAfterStartId = activeId
    setState({ message: 'Finishing the opening audio…' })
    return
  }
  if (state.phase === 'starting') {
    cancel()
    setState({ message: 'Released before the microphone was ready. Hold until the microphone bars appear, then speak.' })
    return
  }
  if (state.phase !== 'recording') return
  clearCaptureTimer()
  setState({ phase: 'transcribing', level: 0, message: 'Processing your voice on this Mac…' })
  capture({ action: 'stop', sessionId: activeId })
  const id = activeId
  captureTimer = setTimeout(() => fail(new Error('The recorder did not finish. Please retry.'), id), 15_000)
}
async function toggle() {
  if (state.phase === 'recording' || state.phase === 'starting') stopRecording()
  else gesture.beginLocked()
}
async function startRecording() {
  if (quitting || isBusy() || state.inputSuspended) return
  const id = ++activeId
  try {
    assertEngine()
    const controller = new AbortController()
    operation = controller
    cueWarning = ''
    lastAudio = null
    previewController?.abort()
    setState({ phase: 'starting', message: 'Opening your microphone…', level: 0, startedAt: null, delivery: null, inputDevice: null, inputWarning: '', canRetry: false })
    // Snapshot the destination at key-down, in parallel with microphone startup.
    // Each recording owns its promise; cancelled snapshots cannot replace it.
    destinationWork = e2e && !process.env.TERRY_E2E_NATIVE_HELPER ? Promise.resolve(null) : frontmost(helper, controller.signal).catch(() => null)
    globalShortcut.register('Escape', cancel)
    const fastStart = state.settings.activationSound === 'buzz' || state.settings.activationSound === 'off'
    stopAfterStartId = -1
    if (!e2e && process.platform === 'darwin') {
      const allowed = systemPreferences.getMediaAccessStatus('microphone') === 'granted' || await systemPreferences.askForMediaAccess('microphone')
      if (id !== activeId || controller.signal.aborted) return
      if (!allowed) throw new Error('Microphone access is off. Open Settings below, allow Terry Tibbs in macOS Microphone settings, then restart the app.')
      if (state.microphone !== 'granted') setState({ microphone: 'granted' })
    }
    // A voice preview still has to stop before capture. The normal fast path has
    // no pending preview and sends capture before awaiting any mute/cue work.
    if (previewWork) await previewWork.catch(() => undefined)
    if (id !== activeId || controller.signal.aborted) return
    const beginCapture = () => {
      capture({ action: 'start', sessionId: id, microphoneId: state.settings.microphoneId, includePreRoll: fastStart })
      captureTimer = setTimeout(() => fail(new Error('The microphone did not start. Check its permission and try again.'), id), 15_000)
    }
    // Retain audio before showing the overlay. Window work must
    // never sit in front of the fast capture command.
    if (fastStart) beginCapture()
    showHud()
    await audioRestoreWork
    if (id !== activeId || controller.signal.aborted || !['starting', 'recording'].includes(state.phase)) return
    let guard: AudioLease | null = null
    if (state.settings.muteOtherAudio || state.settings.activationSound === 'buzz') {
      if (!fastStart) setState({ message: 'Muting other audio…' })
      audioLeaseService = getAudioService()
      audioLeaseWork = audioLeaseService.activate(controller.signal, error => { if (id === activeId && !controller.signal.aborted && ['starting', 'recording'].includes(state.phase)) fail(error, id) }, state.settings.muteOtherAudio, state.settings.activationSound === 'buzz' ? 'buzz' : undefined)
      guard = await audioLeaseWork
      if (id !== activeId || controller.signal.aborted || !['starting', 'recording'].includes(state.phase)) { await guard.stop(); return }
    }
    if (state.settings.activationSound === 'buzz') {
      // The short nonverbal cue can overlap speech. Never erase or postpone the
      // first syllable just to make the cue absent from the microphone signal.
      cueWork = guard!.activationCue!.then(() => ({ played: true }))
      void cueWork.catch(error => { if (id === activeId && !controller.signal.aborted && ['starting', 'recording'].includes(state.phase)) setState({ message: 'Listening. The short cue could not play.' }) })
    } else if (state.settings.activationSound !== 'off') {
      await cueWork?.catch(() => undefined)
      if (id !== activeId || controller.signal.aborted) return
      setState({ message: 'Playing activation sound. Speak when the microphone bars appear…' })
      cueWork = activationSounds.play(state.settings, controller.signal, guard ? async path => {
        try { await guard.play(path); return { played: true } }
        catch (error) { if (error instanceof Error && error.name === 'ActivationSoundError') return { played: false, warning: error.message }; throw error }
        finally { await new Promise(resolve => setTimeout(resolve, 150)) }
      } : undefined)
      const cue = await cueWork
      cueWarning = cue.warning || ''
      if (id !== activeId || controller.signal.aborted) return
      setState({ message: 'Opening your microphone…' })
    }
    if (!fastStart) beginCapture()
  } catch (error) {
    // Capture can finish before native mute activation. Its later rejection must
    // not abort valid audio that is already transcribing or replace its result.
    if (completedCaptureId !== id) fail(error, id)
  }
}
async function processAudio(wav: Buffer, id: number, paste: boolean) {
  const start = performance.now()
  const controller = operation ?? new AbortController()
  operation = controller
  const settings = { ...state.settings }
  const recordingDestination = destinationWork
  try {
    assertEngine()
    validateWav(wav)
    if (id !== activeId) return
    lastAudio = wav
    setState({ phase: 'transcribing', message: 'Transcribing on your Mac…', canRetry: true, level: 0 })
    const detectorModel = app.isPackaged ? join(process.resourcesPath, VAD_MODEL_NAME) : resolve(__dirname, '../../resources', VAD_MODEL_NAME)
    await requireSpeech(wav, settings.whisperPath, detectorModel, controller.signal)
    const server = await prepareSpeechEngine(settings)
    controller.signal.throwIfAborted()
    const result = await transcribeWav(wav, settings, controller.signal, server)
    if (id !== activeId) return
    const rawTranscript = { raw: result.raw, text: result.raw, durationMs: result.durationMs, processingMs: Math.round(performance.now() - start), createdAt: Date.now() }
    // Commit a completed transcript only after cleanup settles. Cancellation preserves the previous result.
    if (settings.cleanupEnabled) setState({ phase: 'cleaning', message: 'Tidying with your local model…' })
    const cleaned = await cleanTranscript(result.raw, settings, controller.signal)
    if (id !== activeId) return
    const text = settings.correctionsEnabled ? applyCorrections(cleaned.text, settings.corrections) : cleaned.text
    const transcript = { ...rawTranscript, text, processingMs: Math.round(performance.now() - start) }
    controller.signal.throwIfAborted()
    if (id !== activeId) return
    let message = cleaned.warning ? `${cleaned.warning} Copied to clipboard.` : 'Copied to clipboard. Paste wherever you like.'
    let delivery: 'sent' | 'clipboard' = 'clipboard'
    if (paste && settings.autoPaste) {
      const target = await recordingDestination
      if (id !== activeId || controller.signal.aborted) return
      const result = await pasteTranscript(helper, text, target, controller.signal)
      if (id !== activeId) return
      delivery = result.status
      message = cleaned.warning ? `${cleaned.warning} ${result.message}` : result.message
    }
    if (delivery === 'clipboard') clipboard.writeText(text)
    operation = null
    gesture.reset()
    releaseEscape()
    setState({ phase: 'ready', transcript: { ...transcript, delivery, deliveryMessage: message }, message, delivery, startedAt: null, level: 0, inputWarning: '' })
    if (paste) { showHud(); hudTimer = setTimeout(hideHud, delivery === 'clipboard' ? 7000 : 2500) } else hideHud()
  } catch (error) {
    if (id === activeId && !controller.signal.aborted) fail(error, id)
  }
}
async function retry() {
  if (isBusy() || !lastAudio) return
  const id = ++activeId
  operation = new AbortController()
  destinationWork = Promise.resolve(null)
  globalShortcut.register('Escape', cancel)
  await processAudio(lastAudio, id, false)
}
async function importAudio() {
  if (isBusy()) return
  const result = await dialog.showOpenDialog(main, { properties: ['openFile'], title: 'Transcribe a WAV recording', filters: [{ name: '16 kHz mono PCM WAV (up to 2 minutes)', extensions: ['wav'] }] })
  if (result.canceled || !result.filePaths[0] || isBusy()) return
  const id = ++activeId
  try {
    operation = new AbortController()
    destinationWork = Promise.resolve(null)
    lastAudio = null
    setState({ phase: 'transcribing', message: 'Reading your local audio file…', level: 0, canRetry: false })
    globalShortcut.register('Escape', cancel)
    const path = result.filePaths[0]
    const info = await stat(path)
    if (id !== activeId) return
    if (info.size > 4_000_000) throw new Error('Choose a 16 kHz mono PCM WAV no longer than two minutes (under 4 MB).')
    const wav = await readFile(path)
    if (id !== activeId) return
    validateWav(wav)
    await processAudio(wav, id, false)
  } catch (error) { fail(error, id) }
}
function handleHotkey(event: HotkeyEvent) {
  if (event.type === 'candidate') {
    if (shortcutSuspended && main?.isFocused() && event.shortcut) main.webContents.send('terry:shortcut-candidate', event.shortcut)
    return
  }
  if (event.type === 'ready') { setState({ shortcutReady: true }); return }
  if (event.type === 'unavailable') {
    setState({ shortcutReady: false })
    if (state.phase === 'recording' || state.phase === 'starting') cancel()
    if (!isBusy()) setState({ message: event.message || 'Allow Accessibility in Settings to enable your dictation shortcut.' })
    return
  }
  if (event.type === 'cancel') { if (state.phase === 'recording' || state.phase === 'starting') cancel(); else gesture.reset(); return }
  if (shortcutSuspended) return
  if (event.type === 'down') gesture.down()
  if (event.type === 'up') gesture.up()
}
function startMonitor() {
  const generation = ++monitorGeneration
  monitor?.stop(); monitor = null
  setState({ shortcutReady: false })
  if (e2e) { setState({ shortcutReady: true }); return }
  monitor = createHotkeyMonitor(helper, state.settings.shortcut, event => {
    if (!quitting && generation === monitorGeneration) handleHotkey(event)
  })
  void monitor.suspend(shortcutSuspended).catch(error => { if (generation === monitorGeneration) handleHotkey({ type: 'unavailable', message: errorText(error) }) })
}
function suspendShortcut(paused: boolean): Promise<void> {
  if (shortcutSuspended === paused) return shortcutTransition
  shortcutSuspended = paused
  gesture.reset()
  shortcutTransition = Promise.resolve(monitor?.suspend(paused)).catch(error => {
    // A failed acknowledgement must not leave the current shortcut intercepted.
    monitorGeneration++; monitor?.stop(); monitor = null
    shortcutSuspended = false
    setState({ shortcutReady: false, message: errorText(error) })
    throw error
  })
  return shortcutTransition
}
function showSettings() { main.show(); main.webContents.send('terry:settings') }
function updateTray() {
  if (!tray || !state) return
  const micLabel = state.microphoneReady || state.phase === 'recording' ? state.inputDevice?.label : state.settings.microphoneLabel
  const signature = JSON.stringify([state.phase, state.recordingMode, state.shortcutReady, state.settings.shortcut, micLabel, state.microphoneReady])
  if (signature === traySignature) return
  traySignature = signature
  const activity = state.phase === 'recording' ? (state.recordingMode === 'locked' ? '▣' : '●') : isBusy() ? '···' : ''
  // Keep a usable menu if a future macOS build cannot resolve the system symbol.
  tray.setTitle([trayIconAvailable ? '' : 'TT', activity].filter(Boolean).join(' '))
  tray.setToolTip(`Terry Tibbs: ${state.phase}${state.recordingMode === 'locked' ? ', locked' : ''}. ${formatShortcut(state.settings.shortcut)}`)
  trayMenu = Menu.buildFromTemplate([
    { label: 'Open Terry Tibbs', click: () => main.show() },
    { label: `Microphone: ${micLabel || 'System default'}…`, click: () => { main.show(); main.webContents.send('terry:settings', 'microphone') } },
    { label: `Shortcut: ${formatShortcut(state.settings.shortcut)}…`, click: () => { main.show(); main.webContents.send('terry:settings', 'shortcut') } },
    { label: state.shortcutReady ? 'Hold to talk · double-tap to lock' : 'Enable shortcut access in Settings', enabled: false },
    { type: 'separator' },
    { label: state.phase === 'recording' || state.phase === 'starting' ? 'Finish dictation' : 'Start locked dictation', enabled: !['transcribing', 'cleaning'].includes(state.phase), click: () => { void toggle() } },
    { label: 'Settings…', click: showSettings },
    { type: 'separator' },
    { label: 'Quit Terry Tibbs', click: () => app.quit() }
  ])
  tray.setContextMenu(trayMenu)
}
async function saveSettings(value: unknown) {
  if (isBusy()) throw new Error('Finish or cancel your dictation before changing Settings.')
  if (download) throw new Error('Wait for the model download before changing Settings.')
  const settings = validateSettings(value)
  parseShortcut(settings.shortcut)
  const changed = settings.shortcut !== state.settings.shortcut
  const inputChanged = settings.microphoneId !== state.settings.microphoneId
  persistSettings(app.getPath('userData'), settings)
  setState({ settings, phase: 'ready', message: 'Settings saved. Hold to talk, or double-tap to lock.', ...(inputChanged ? { inputDevice: null, inputWarning: '', microphoneReady: false, microphonePreparation: '' } : {}) })
  if (changed) startMonitor()
  void prepareSpeechEngine(settings)
  prepareBackgroundAudio()
  await refresh()
}
function ipc() {
  function handle(name: string, fn: (...args: any[]) => unknown) {
    ipcMain.handle(`terry:${name}`, async (event, ...args) => {
      if (![main?.webContents, hud?.webContents].includes(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted caller.')
      return await fn(...args)
    })
  }
  handle('get-state', () => state)
  handle('hide-window', async () => { await suspendShortcut(false).catch(() => undefined); main.hide() })
  handle('suspend-shortcut', async (paused: unknown) => { if (typeof paused !== 'boolean') throw new Error('Invalid shortcut state.'); if (paused && isBusy()) throw new Error('Finish dictation before choosing a shortcut.'); await suspendShortcut(paused) })
  handle('toggle', toggle)
  handle('cancel', cancel)
  handle('retry', retry)
  handle('import-audio', importAudio)
  handle('refresh', refresh)
  handle('save-settings', saveSettings)
  handle('select-microphone', async (deviceId: unknown, label: unknown) => {
    if (typeof deviceId !== 'string' || typeof label !== 'string') throw new Error('Choose a valid microphone.')
    await saveSettings({ ...state.settings, microphoneId: deviceId, microphoneLabel: label })
    setState({ message: `${label || 'System default microphone'} selected and saved.` })
  })
  handle('learn-corrections', (createdAt: unknown, correctedText: unknown, selected: unknown) => {
    if (isBusy()) throw new Error('Finish dictation before saving corrections.')
    if (!state.transcript || state.transcript.createdAt !== createdAt) throw new Error('The transcript changed. Reopen Correct words for the latest text.')
    if (typeof correctedText !== 'string' || !correctedText.trim() || correctedText.length > 10_000 || correctedText.includes('\0')) throw new Error('Use a corrected transcript of up to 10,000 characters.')
    const rules = validateCorrections(selected)
    const suggestions = suggestCorrections(state.transcript.text, correctedText)
    if (!rules.length || rules.some(rule => !suggestions.some(item => item.from === rule.from && item.to === rule.to))) throw new Error('Review the suggested word corrections before saving.')
    const settings = validateSettings({ ...state.settings, corrections: [...state.settings.corrections, ...rules] })
    persistSettings(app.getPath('userData'), settings)
    const message = `${rules.length} correction${rules.length === 1 ? '' : 's'} remembered on this Mac. Corrected text is ready to copy; the previous paste is unchanged.`
    setState({ settings, transcript: { ...state.transcript, text: correctedText.trim(), deliveryMessage: message }, message })
  })
  handle('list-sound-clips', async (value: unknown) => availableSoundClips(validateSettings(value).activationSoundDirectory))
  handle('show-settings', showSettings)
  handle('copy', async (raw: unknown) => {
    if (!state.transcript) return
    await clipboard.writeText(raw === true ? state.transcript.raw : state.transcript.text)
    setState({ delivery: 'clipboard', message: raw === true ? 'Raw transcript copied.' : 'Copied. Paste wherever you like.' })
  })
  handle('clear', () => { if (isBusy()) return; lastAudio = null; setState({ transcript: null, canRetry: false, message: 'Cleared from memory.' }) })
  handle('choose-file', async (kind: unknown) => {
    if (kind !== 'engine' && kind !== 'model' && kind !== 'sounds') throw new Error('Invalid file type.')
    const result = await dialog.showOpenDialog(main, { properties: [kind === 'sounds' ? 'openDirectory' : 'openFile'], title: kind === 'sounds' ? 'Choose your activation voice clips folder' : kind === 'engine' ? 'Choose whisper-cli' : 'Choose a Whisper GGML model', ...(kind === 'model' ? { filters: [{ name: 'Whisper models', extensions: ['bin'] }] } : {}) })
    return result.canceled ? null : result.filePaths[0]
  })
  handle('preview-sound', async (value: unknown) => {
    if (quitting) throw new Error('Terry Tibbs is quitting.')
    if (isBusy()) throw new Error('Finish or cancel dictation before previewing a sound.')
    const settings = validateSettings(value)
    previewController?.abort()
    await previewWork?.catch(() => undefined)
    if (quitting) throw new Error('Terry Tibbs is quitting.')
    if (isBusy()) throw new Error('Finish or cancel dictation before previewing a sound.')
    const controller = new AbortController()
    previewController = controller
    previewWork = settings.activationSound === 'buzz' ? (async () => {
      await audioRestoreWork
      const lease = await getAudioService().activate(controller.signal, () => undefined, false)
      try { await lease.buzz(); return { played: true } }
      finally { await lease.stop() }
    })() : activationSounds.preview(settings, controller.signal)
    try { return await previewWork }
    catch (error) { if (controller.signal.aborted) return { played: false }; throw error }
    finally { if (previewController === controller) { previewController = null; previewWork = null } }
  })
  handle('open-permission', async (kind: unknown) => {
    if (kind === 'microphone') {
      await systemPreferences.askForMediaAccess('microphone')
      if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
    } else if (kind === 'accessibility') {
      await requestAccessibility(helper)
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    } else throw new Error('Unknown permission.')
    await refresh()
  })
  handle('download-model', async () => {
    if (download || isBusy()) return
    download = new AbortController()
    const destination = join(app.getPath('userData'), 'models', MODEL_NAME)
    setState({ modelDownload: 0, message: 'Downloading Whisper Turbo (1.62 GB). This is the only network step for speech recognition.' })
    try {
      await downloadModelFile(destination, progress => setState({ modelDownload: progress }), download.signal)
      const settings = { ...state.settings, modelPath: destination }
      persistSettings(app.getPath('userData'), settings)
      setState({ settings, phase: 'ready', message: 'Whisper Turbo downloaded and verified. Ready for offline dictation.', modelReady: true })
    } catch (error) { setState({ message: errorText(error), phase: 'error' }) }
    finally { download = null; setState({ modelDownload: null }) }
  })
  ipcMain.on('terry:capture-prepared', (event, ready, input, message) => {
    if (event.sender !== main.webContents || event.senderFrame !== event.sender.mainFrame || typeof ready !== 'boolean') return
    if (ready && (!state.settings.keepMicrophoneReady || state.inputSuspended)) return
    if (ready && (!input || typeof input.label !== 'string' || typeof input.deviceId !== 'string' || !Number.isFinite(input.sampleRate))) return
    setState({ microphoneReady: ready, microphonePreparation: typeof message === 'string' ? message.slice(0, 400) : ready ? 'Microphone ready. Speak as you press your shortcut.' : '', ...(ready ? { inputDevice: { label: input.label.slice(0,256), deviceId: input.deviceId.slice(0,512), sampleRate: input.sampleRate } } : {}) })
  })
  ipcMain.on('terry:capture-started', (event, id, input) => {
    if (event.sender !== main.webContents || event.senderFrame !== event.sender.mainFrame || id !== activeId || state.phase !== 'starting') return
    if (!input || typeof input.label !== 'string' || typeof input.deviceId !== 'string' || !Number.isFinite(input.sampleRate) || input.sampleRate <= 0 || input.sampleRate > 384_000) { fail(new Error('The microphone did not report a valid input device.'), id); return }
    clearCaptureTimer()
    setState({ phase: 'recording', microphone: e2e ? 'test device' : 'granted', inputDevice: { deviceId: input.deviceId.slice(0, 512), label: input.label.slice(0, 256), sampleRate: input.sampleRate }, inputWarning: '', startedAt: Date.now(), message: (cueWarning ? `${cueWarning} ` : '') + (state.recordingMode === 'locked' ? 'Listening locked. Press your shortcut to finish.' : 'Listening. Release your shortcut to finish.') })
    captureTimer = setTimeout(() => { if (state.phase === 'recording') void toggle() }, 119_000)
    if (stopAfterStartId === id) { stopAfterStartId = -1; stopRecording() }
  })
  ipcMain.on('terry:capture-warning', (event, id, message) => {
    if (event.sender !== main.webContents || event.senderFrame !== event.sender.mainFrame || id !== activeId || state.phase !== 'recording' || typeof message !== 'string') return
    const inputWarning = message.slice(0, 400)
    setState({ inputWarning, message: inputWarning || (state.recordingMode === 'locked' ? 'Listening locked. Press your shortcut to finish.' : 'Listening. Release your shortcut to finish.') })
  })
  ipcMain.on('terry:capture-level', (event, id, level) => {
    if (event.sender !== main.webContents || event.senderFrame !== event.sender.mainFrame || id !== activeId || state.phase !== 'recording' || !Number.isFinite(level)) return
    setState({ level: Math.max(0, Math.min(1, level)) })
  })
  ipcMain.on('terry:capture-failed', (event, id, message, samples) => {
    if (event.sender !== main.webContents || event.senderFrame !== event.sender.mainFrame || id !== activeId || !isBusy()) return
    let reason = typeof message === 'string' ? message.slice(0, 400) : 'Microphone capture failed.'
    if (samples instanceof Float32Array) {
      try { lastAudio = pcmToWav(samples); reason += ' Captured audio is kept in memory. Use Retry audio to recover it.' }
      catch { /* Empty or unusable partial audio must not become a recoverable recording. */ }
    }
    fail(new Error(reason), id)
  })
  ipcMain.on('terry:capture-complete', (event, id, samples) => {
    if (event.sender !== main.webContents || event.senderFrame !== event.sender.mainFrame || id !== activeId || !['recording', 'transcribing'].includes(state.phase)) return
    if (completedCaptureId === id) return
    completedCaptureId = id
    capture({ action: 'cancel', sessionId: id })
    void releaseBackgroundAudio()
    clearCaptureTimer()
    try {
      if (!(samples instanceof Float32Array)) throw new Error('Invalid microphone audio.')
      if (samples.length < 4_800) throw new NoSpeechError()
      const wav = pcmToWav(samples)
      void processAudio(wav, id, true)
    } catch (error) { fail(error, id) }
  })
}
function createWindows() {
  const preload = join(__dirname, '../preload/index.js')
  main = new BrowserWindow({ width: 1040, height: 810, minWidth: 360, minHeight: 560, title: 'Terry Tibbs', backgroundColor: '#f6f4ed', show: false, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  hud = new BrowserWindow({ width: HUD_WIDTH, height: HUD_HEIGHT, hasShadow: false, resizable: false, movable: false, frame: false, transparent: true, show: false, focusable: false, alwaysOnTop: true, skipTaskbar: true, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  hud.setIgnoreMouseEvents(true)
  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  for (const win of [main, hud]) {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.webContents.on('render-process-gone', () => { if (!quitting && state) fail(new Error('The interface stopped. Restart Terry Tibbs to record again.')) })
    if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged) void win.loadURL(process.env.ELECTRON_RENDERER_URL + (win === hud ? '#hud' : ''))
    else void win.loadFile(join(__dirname, '../renderer/index.html'), win === hud ? { hash: 'hud' } : {})
  }
  main.once('ready-to-show', () => main.show())
  main.on('close', event => { if (!quitting) { event.preventDefault(); void suspendShortcut(false).catch(() => undefined); main.hide() } })
  main.on('blur', () => { void suspendShortcut(false).catch(() => undefined) })
  main.webContents.on('render-process-gone', () => { void suspendShortcut(false).catch(() => undefined) })
  main.on('focus', () => { if (state && !isBusy()) void refresh() })
}
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (main) main.show() })
  void app.whenReady().then(async () => {
    if (process.platform !== 'darwin') { dialog.showErrorBox('macOS required', 'This version of Terry Tibbs supports macOS.'); app.quit(); return }
    const userData = app.getPath('userData')
    mkdirSync(userData, { recursive: true, mode: 0o700 })
    helper = app.isPackaged ? join(process.resourcesPath, 'terry-native') : (e2e && process.env.TERRY_E2E_NATIVE_HELPER) || resolve(__dirname, '../../build/terry-native')
    const settings = loadSettings(userData)
    state = { phase: 'ready', recordingMode: null, shortcutReady: false, message: 'Ready when you are.', level: 0, startedAt: null, transcript: null, canRetry: false, delivery: null, settings, engineReady: engineExists(settings.whisperPath), modelReady: modelExists(settings.modelPath), microphone: 'not-determined', microphoneReady: false, microphonePreparation: '', inputSuspended: false, inputDevice: null, inputWarning: '', accessibility: false, localModels: [], modelDownload: null }
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const types = (details as { mediaTypes?: string[] }).mediaTypes
      callback(webContents === main?.webContents && permission === 'media' && !!types?.length && types.every(type => type === 'audio'))
    })
    session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => webContents === main?.webContents && permission === 'media' && details.mediaType === 'audio')
    ipc(); createWindows()
    void prepareSpeechEngine(settings)
    prepareBackgroundAudio()
    const cancelForSystemPause = () => {
      setState({ inputSuspended: true, microphoneReady: false, microphonePreparation: 'Microphone paused while the Mac is locked or asleep.' })
      if (state.phase === 'starting' || state.phase === 'recording') cancel()
      else capture({ action: 'cancel', sessionId: activeId })
    }
    powerMonitor.on('lock-screen', () => { screenLocked = true; cancelForSystemPause() })
    powerMonitor.on('suspend', () => { systemSuspended = true; cancelForSystemPause() })
    powerMonitor.on('unlock-screen', () => { screenLocked = false; if (!systemSuspended) setState({ inputSuspended: false }) })
    powerMonitor.on('resume', () => { systemSuspended = false; if (!screenLocked) setState({ inputSuspended: false }) })
    let trayIcon = nativeImage.createFromNamedImage('mic.fill', { pointSize: 16, weight: 'regular' })
    if (!trayIcon.isEmpty() && trayIcon.getSize().height > 18) trayIcon = trayIcon.resize({ height: 18 })
    trayIcon.setTemplateImage(true)
    trayIconAvailable = !trayIcon.isEmpty()
    tray = new Tray(trayIcon)
    updateTray()
    if (!e2e) app.dock?.hide()
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Terry Tibbs', submenu: [{ role: 'about' }, { label: 'Settings…', accelerator: 'Command+,', click: showSettings }, { label: 'Close to menu bar', accelerator: 'Command+W', click: () => main.close() }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] }, { role: 'editMenu' }, { label: 'Window', submenu: [{ role: 'minimize' }, { label: 'Show Terry Tibbs', click: () => main.show() }] }]))
    startMonitor()
    if (e2e) {
      // Test-only native boundary. Never exposed through preload or in packaged builds.
      (globalThis as any).__terryHotkey = handleHotkey
      ;(globalThis as any).__terryMenu = () => trayMenu
      ;(globalThis as any).__terryTray = () => ({ title: tray.getTitle(), bounds: tray.getBounds(), iconSize: trayIcon.getSize(), template: trayIcon.isTemplateImage(), empty: trayIcon.isEmpty(), png2x: trayIcon.toPNG({ scaleFactor: 2 }).toString('base64') })
    }
    await refresh()
  }).catch(error => { dialog.showErrorBox('Terry Tibbs could not start', errorText(error)); app.quit() })
}
app.on('activate', () => { if (main) main.show() })
app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  capture({ action: 'shutdown', sessionId: activeId })
  monitorGeneration++; monitor?.stop(); gesture.reset(); hideHud(); activeId++
  operation?.abort(); previewController?.abort(); download?.abort(); clearCaptureTimer(); globalShortcut.unregisterAll(); lastAudio = null
  warmEngine?.controller.abort()
  void Promise.all([releaseBackgroundAudio().then(() => audioService?.stop()), (warmEngine?.ready ?? Promise.resolve(undefined)).then(handle => stopWhisperServer(handle)), cueWork?.catch(() => undefined), previewWork?.catch(() => undefined)]).finally(() => app.quit())
})
app.on('window-all-closed', () => { /* The menu-bar app stays available until Quit. */ })
