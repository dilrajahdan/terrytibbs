import { accessSync, constants, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import type { Settings } from '../shared/types'
import { MODEL_NAME } from './model'
import { parseShortcut } from '../shared/shortcut'
import { validateCorrections } from '../shared/corrections'

export function engineExists(path: string): boolean {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile() } catch { return false }
}
export function modelExists(path: string): boolean {
  try { return statSync(path).isFile() && statSync(path).size > 1_000_000 } catch { return false }
}
export function defaultSettings(userData: string): Settings {
  const paths = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli']
  return {
    whisperPath: paths.find(engineExists) || paths[0],
    modelPath: join(userData, 'models', MODEL_NAME),
    shortcut: 'Alt+Space', language: 'en', vocabulary: '', correctionsEnabled: true, corrections: [], autoPaste: true, muteOtherAudio: true, keepMicrophoneReady: false,
    cleanupEnabled: false, cleanupModel: '', activationSound: 'off', activationSoundDirectory: '', activationSoundClip: '', microphoneId: '', microphoneLabel: ''
  }
}
export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object') throw new Error('Invalid settings.')
  const s = value as Settings
  for (const key of ['whisperPath', 'modelPath', 'shortcut', 'language', 'vocabulary', 'cleanupModel'] as const) {
    if (typeof s[key] !== 'string' || s[key].includes('\0')) throw new Error(`Invalid ${key}.`)
  }
  if (!isAbsolute(s.whisperPath) || !isAbsolute(s.modelPath) || s.whisperPath.length > 4096 || s.modelPath.length > 4096) throw new Error('Choose absolute engine and model file paths.')
  const shortcut = parseShortcut(s.shortcut).value
  const corrections = validateCorrections(s.corrections ?? [])
  const correctionsEnabled = s.correctionsEnabled ?? true
  if (typeof correctionsEnabled !== 'boolean') throw new Error('Invalid corrections setting.')
  const keepMicrophoneReady = s.keepMicrophoneReady ?? false
  if (typeof keepMicrophoneReady !== 'boolean') throw new Error('Invalid microphone readiness setting.')
  const muteOtherAudio = s.muteOtherAudio ?? true
  if (typeof muteOtherAudio !== 'boolean') throw new Error('Invalid background audio setting.')
  const activationSound = s.activationSound ?? 'off'
  const activationSoundDirectory = s.activationSoundDirectory ?? ''
  const activationSoundClip = s.activationSoundClip ?? ''
  const microphoneId = s.microphoneId ?? ''
  const microphoneLabel = s.microphoneLabel ?? ''
  if (typeof microphoneId !== 'string' || microphoneId.includes('\0') || microphoneId.length > 512 || typeof microphoneLabel !== 'string' || microphoneLabel.includes('\0') || microphoneLabel.length > 256) throw new Error('Choose a valid microphone.')
  if (typeof activationSoundClip !== 'string' || activationSoundClip.includes('\0') || activationSoundClip.length > 255 || (activationSoundClip && (basename(activationSoundClip) !== activationSoundClip || activationSoundClip.includes('\\') || activationSoundClip === '.' || activationSoundClip === '..'))) throw new Error('Choose a voice clip from your selected folder.')
  if (!['off', 'buzz', 'chime', 'clips'].includes(activationSound)) throw new Error('Choose a valid activation sound.')
  if (typeof activationSoundDirectory !== 'string' || activationSoundDirectory.includes('\0') || activationSoundDirectory.length > 4096 || (activationSoundDirectory && !isAbsolute(activationSoundDirectory))) throw new Error('Choose an absolute sound folder path.')
  if (activationSound === 'clips' && !activationSoundDirectory) throw new Error('Choose your voice clips folder first.')
  if (!['en', 'auto'].includes(s.language)) throw new Error('Choose English or automatic language detection.')
  if (s.vocabulary.length > 1000) throw new Error('Vocabulary is limited to 1,000 characters.')
  if (s.cleanupModel.length > 200 || /cloud/i.test(s.cleanupModel)) throw new Error('Choose a local Ollama model.')
  if (typeof s.autoPaste !== 'boolean' || typeof s.cleanupEnabled !== 'boolean') throw new Error('Invalid settings switches.')
  if (s.cleanupEnabled && !s.cleanupModel.trim()) throw new Error('Choose an installed local cleanup model first.')
  return { whisperPath: s.whisperPath, modelPath: s.modelPath, shortcut, language: s.language, vocabulary: s.vocabulary.trim(), corrections, correctionsEnabled, autoPaste: s.autoPaste, muteOtherAudio, keepMicrophoneReady, cleanupEnabled: s.cleanupEnabled, cleanupModel: s.cleanupModel.trim(), activationSound, activationSoundDirectory, activationSoundClip, microphoneId, microphoneLabel }
}
export function loadSettings(userData: string): Settings {
  const defaults = defaultSettings(userData)
  const path = join(userData, 'settings.json')
  if (!existsSync(path)) return defaults
  try { return validateSettings({ ...defaults, ...JSON.parse(readFileSync(path, 'utf8')) }) } catch { return defaults }
}
export function persistSettings(userData: string, settings: Settings): void {
  const path = join(userData, 'settings.json')
  writeFileSync(path + '.tmp', JSON.stringify(validateSettings(settings), null, 2), { mode: 0o600 })
  renameSync(path + '.tmp', path)
}
