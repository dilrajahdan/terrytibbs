import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, extname } from 'node:path'
import type { SoundClip } from '../shared/types'

const DEFAULT_PLAYER = '/usr/bin/afplay'
const CHIME_PATH = '/System/Library/Sounds/Tink.aiff'
const MAX_PLAYBACK_MS = 4_000
const SETTLE_MS = 150
const MAX_CLIP_BYTES = 5 * 1024 * 1024
const MAX_CLIPS = 50
const SUPPORTED_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aiff', '.aif', '.caf'])

export type ActivationSound = 'off' | 'buzz' | 'chime' | 'clips'

export interface ActivationSoundConfig {
  activationSound: ActivationSound
  activationSoundDirectory: string
  activationSoundClip?: string
}

export interface ActivationSoundResult {
  played: boolean
  warning?: string
}

interface Clip {
  path: string
}

function abortError(): Error {
  const error = new Error('Operation cancelled')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function warning(message: string): ActivationSoundResult {
  return { played: false, warning: message }
}

async function listClips(directory: string, signal: AbortSignal): Promise<Clip[]> {
  throwIfAborted(signal)
  if (!isAbsolute(directory)) return []
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }

  const candidates = entries
    .filter(entry => entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_CLIPS)
  const clips: Clip[] = []
  for (const name of candidates) {
    throwIfAborted(signal)
    const path = join(directory, name)
    try {
      const details = await stat(path)
      if (details.isFile() && details.size <= MAX_CLIP_BYTES) clips.push({ path })
    } catch {
      // A clip can disappear while the user is editing the local directory.
    }
  }
  return clips
}

export async function availableSoundClips(directory: string): Promise<SoundClip[]> {
  const clips = await listClips(directory, new AbortController().signal)
  return clips.map(({ path }) => ({ name: basename(path), label: basename(path, extname(path)).replace(/^\d+[\s._-]*/, '').replace(/[_-]+/g, ' ').trim() || basename(path) }))
}

function waitForUncancellableSettle(): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, SETTLE_MS)
  })
}

async function playFile(executable: string, path: string, signal: AbortSignal): Promise<ActivationSoundResult> {
  throwIfAborted(signal)
  return await new Promise<ActivationSoundResult>((resolve, reject) => {
    const child = spawn(executable, [path], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true
    })
    let settled = false
    let timedOut = false
    let aborted = false
    let forceKillTimer: NodeJS.Timeout | undefined

    const finish = (result?: ActivationSoundResult, error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(result ?? warning('The activation sound could not be played.'))
    }
    const terminate = (reason: 'abort' | 'timeout'): void => {
      if (settled) return
      if (reason === 'abort') aborted = true
      else timedOut = true
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 250)
      forceKillTimer.unref()
    }
    const onAbort = (): void => terminate('abort')
    const timeoutTimer = setTimeout(() => terminate('timeout'), MAX_PLAYBACK_MS)
    timeoutTimer.unref()
    let playerError = false
    signal.addEventListener('abort', onAbort, { once: true })
    // Even spawn failures emit close. Resolve only there so a failed or cancelled
    // player can never leave an audio tail ahead of the next microphone session.
    child.once('error', () => { playerError = true })
    child.once('close', (code, childSignal) => {
      clearTimeout(timeoutTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      void waitForUncancellableSettle().then(() => {
        if (aborted || signal.aborted) finish(undefined, abortError())
        else if (timedOut) finish(warning('The activation sound took too long and was stopped.'))
        else if (!playerError && code === 0 && !childSignal) finish({ played: true })
        else finish(warning('The activation sound could not be played.'))
      })
    })
    if (signal.aborted) onAbort()
  })
}

export class ActivationSounds {
  private readonly executable: string
  private readonly cursors = new Map<string, number>()
  private playbackTail: Promise<void> = Promise.resolve()

  constructor(executable = DEFAULT_PLAYER) {
    this.executable = executable
  }

  private async withPlaybackLock<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const previous = this.playbackTail
    let release!: () => void
    const slot = new Promise<void>(resolve => {
      release = resolve
    })
    this.playbackTail = previous.then(() => slot, () => slot)
    try {
      await waitForTurn(previous, signal)
      throwIfAborted(signal)
      return await operation()
    } finally {
      release()
    }
  }

  async play(config: ActivationSoundConfig, signal: AbortSignal, player?: (path: string, signal: AbortSignal) => Promise<ActivationSoundResult>): Promise<ActivationSoundResult> {
    const play = player || ((path: string, signal: AbortSignal) => playFile(this.executable, path, signal))
    throwIfAborted(signal)
    if (config.activationSound === 'off') return { played: false }
    if (config.activationSound === 'chime') {
      return await this.withPlaybackLock(signal, () => play(CHIME_PATH, signal))
    }
    if (config.activationSound !== 'clips') return warning('The activation sound setting is invalid.')

    return await this.withPlaybackLock(signal, async () => {
      const clips = await listClips(config.activationSoundDirectory, signal)
      if (!clips.length) return warning('No playable local activation clips were found.')
      if (config.activationSoundClip) {
        const selected = clips.find(clip => basename(clip.path) === config.activationSoundClip)
        return selected ? await play(selected.path, signal) : warning('Your selected voice clip is unavailable. Choose another in Settings.')
      }
      const current = this.cursors.get(config.activationSoundDirectory) ?? 0
      const index = current % clips.length
      this.cursors.set(config.activationSoundDirectory, (index + 1) % clips.length)
      return await play(clips[index].path, signal)
    })
  }

  async preview(config: ActivationSoundConfig, signal: AbortSignal): Promise<ActivationSoundResult> {
    throwIfAborted(signal)
    if (config.activationSound === 'off') return { played: false }
    if (config.activationSound === 'chime') {
      return await this.withPlaybackLock(signal, () => playFile(this.executable, CHIME_PATH, signal))
    }
    if (config.activationSound !== 'clips') return warning('The activation sound setting is invalid.')

    return await this.withPlaybackLock(signal, async () => {
      const clips = await listClips(config.activationSoundDirectory, signal)
      if (!clips.length) return warning('No playable local activation clips were found.')
      if (config.activationSoundClip) {
        const selected = clips.find(clip => basename(clip.path) === config.activationSoundClip)
        return selected ? await playFile(this.executable, selected.path, signal) : warning('Your selected voice clip is unavailable. Choose another in Settings.')
      }
      const current = this.cursors.get(config.activationSoundDirectory) ?? 0
      return await playFile(this.executable, clips[current % clips.length].path, signal)
    })
  }
}

function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    let settled = false
    const onAbort = (): void => finish(abortError())
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void previous.then(() => finish(), error => finish(error instanceof Error ? error : new Error(String(error))))
  })
}
