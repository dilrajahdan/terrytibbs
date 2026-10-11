export type Phase = 'ready' | 'starting' | 'recording' | 'transcribing' | 'cleaning' | 'error'
export interface Settings {
  whisperPath: string
  modelPath: string
  shortcut: string
  language: string
  vocabulary: string
  keepMicrophoneReady: boolean
  muteOtherAudio: boolean
  autoPaste: boolean
  cleanupEnabled: boolean
  cleanupModel: string
  activationSound: 'off' | 'buzz' | 'chime' | 'clips'
  activationSoundDirectory: string
  activationSoundClip: string
  microphoneId: string
  microphoneLabel: string
}
export interface InputDevice { deviceId: string; label: string; sampleRate: number }
export interface SoundClip { name: string; label: string }
export interface Transcript {
  delivery?: 'sent' | 'clipboard'
  deliveryMessage?: string
  raw: string
  text: string
  durationMs: number
  processingMs: number
  createdAt: number
}
export interface AppState {
  phase: Phase
  recordingMode: 'hold' | 'locked' | null
  shortcutReady: boolean
  message: string
  level: number
  startedAt: number | null
  transcript: Transcript | null
  canRetry: boolean
  delivery: 'sent' | 'clipboard' | 'none' | null
  settings: Settings
  engineReady: boolean
  modelReady: boolean
  microphone: string
  microphoneReady: boolean
  microphonePreparation: string
  inputSuspended: boolean
  inputDevice: InputDevice | null
  inputWarning: string
  accessibility: boolean
  localModels: string[]
  modelDownload: number | null
}
export type CaptureCommand = { action: 'start' | 'stop' | 'cancel' | 'shutdown'; sessionId: number; microphoneId?: string; includePreRoll?: boolean }
export interface TerryAPI {
  getState(): Promise<AppState>
  hideWindow(): Promise<void>
  onShortcutCandidate(callback: (shortcut: string) => void): () => void
  suspendShortcut(paused: boolean): Promise<void>
  toggle(): Promise<void>
  cancel(): Promise<void>
  retry(): Promise<void>
  importAudio(): Promise<void>
  copyTranscript(raw?: boolean): Promise<void>
  clearTranscript(): Promise<void>
  saveSettings(settings: Settings): Promise<void>
  chooseFile(kind: 'engine' | 'model' | 'sounds'): Promise<string | null>
  previewSound(settings: Settings): Promise<{ played: boolean; warning?: string }>
  listSoundClips(settings: Settings): Promise<SoundClip[]>
  downloadModel(): Promise<void>
  refresh(): Promise<void>
  openPermission(kind: 'microphone' | 'accessibility'): Promise<void>
  showSettings(): Promise<void>
  onOpenSettings(callback: (target?: 'shortcut') => void): () => void
  onState(callback: (state: AppState) => void): () => void
  onCapture(callback: (command: CaptureCommand) => void): () => void
  capturePrepared(ready: boolean, inputDevice?: InputDevice, message?: string): void
  captureStarted(sessionId: number, inputDevice: InputDevice): void
  captureWarning(sessionId: number, message: string): void
  captureLevel(sessionId: number, level: number): void
  captureComplete(sessionId: number, samples: Float32Array): void
  captureFailed(sessionId: number, message: string, samples?: Float32Array): void
}
declare global { interface Window { terry: TerryAPI } }
