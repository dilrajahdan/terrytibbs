import { spawn, type ChildProcess } from 'node:child_process'
import { access, chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Settings } from '../shared/types'

const DEFAULT_START_TIMEOUT_MS = 120_000
const REQUEST_TIMEOUT_MS = 120_000
const MAX_RESPONSE_BYTES = 1_048_576

export interface WhisperServerStartOptions {
  executable: string
  modelPath: string
  startupTimeoutMs?: number
  signal?: AbortSignal
}

export interface WhisperServerTranscriptionOptions {
  language: Settings['language']
  vocabulary: Settings['vocabulary']
}

export class WhisperServerUnavailableError extends Error {
  constructor(message = 'The local Whisper server is unavailable.') {
    super(message)
    this.name = 'WhisperServerUnavailableError'
  }
}

export class WhisperServerRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WhisperServerRequestError'
  }
}

export class WhisperServerInvalidAudioError extends Error {
  constructor(message = 'The local Whisper server rejected the audio.') {
    super(message)
    this.name = 'WhisperServerInvalidAudioError'
  }
}

export interface WhisperServerHandle {
  readonly baseUrl: string
  readonly pid: number
  readonly running: boolean
  transcribe(
    wav: Buffer,
    options: WhisperServerTranscriptionOptions,
    signal: AbortSignal
  ): Promise<string>
  stop(): Promise<void>
}

function abortError(): Error {
  const error = new Error('Operation cancelled')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

async function requireFile(path: string, label: string, executable = false): Promise<void> {
  if (!path.trim()) throw new Error(`${label} path is not configured`)
  try {
    const fileStats = await stat(path)
    await access(path, executable ? fsConstants.X_OK : fsConstants.R_OK)
    if (!fileStats.isFile()) throw new Error(`${label} path must point to a file`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} path must`)) throw error
    throw new Error(`${label} file is missing or inaccessible`)
  }
}

async function freeLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('Could not reserve a local Whisper port.')))
        return
      }
      const port = address.port
      probe.close(error => error ? reject(error) : resolve(port))
    })
  })
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    let settled = false
    const onAbort = (): void => finish(abortError())
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(), delayMs)
    timer.unref()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function waitForServer(
  child: ChildProcess,
  baseUrl: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let processError: unknown = null
  const onError = (error: Error): void => { processError = error }
  child.once('error', onError)
  try {
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      if (processError || child.exitCode !== null || child.signalCode !== null) {
        const startupMessage = processError instanceof Error ? processError.message : 'The local Whisper server stopped while loading the model.'
        throw new WhisperServerUnavailableError(startupMessage)
      }
      try {
        const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000), redirect: 'error' })
        if (response.status === 200) {
          const body = await response.text()
          if (body.includes('"status":"ok"')) return
        }
      } catch {
        // The server is still binding or loading. Keep polling within the bound.
      }
      await wait(100, signal)
    }
  } finally {
    child.removeListener('error', onError)
  }
  throw new WhisperServerUnavailableError('The local Whisper server did not become ready in time.')
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(forceKillTimer)
      resolve()
    }
    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      finish()
    }, 1_000)
    forceKillTimer.unref()
    child.once('close', finish)
    child.kill('SIGTERM')
  })
}

class LocalWhisperServer implements WhisperServerHandle {
  readonly baseUrl: string
  readonly pid: number
  private stopped = false
  private readonly child: ChildProcess
  private readonly publicDirectory: string
  private readonly requests = new Set<AbortController>()
  private stopPromise: Promise<void> | null = null

  constructor(child: ChildProcess, port: number, publicDirectory: string) {
    if (!child.pid) throw new WhisperServerUnavailableError('The local Whisper server has no process id.')
    this.child = child
    this.pid = child.pid
    this.baseUrl = `http://127.0.0.1:${port}`
    this.publicDirectory = publicDirectory
  }

  get running(): boolean {
    return !this.stopped && this.child.exitCode === null && this.child.signalCode === null
  }

  async transcribe(
    wav: Buffer,
    options: WhisperServerTranscriptionOptions,
    signal: AbortSignal
  ): Promise<string> {
    throwIfAborted(signal)
    if (!this.running) {
      throw new WhisperServerUnavailableError()
    }

    const requestController = new AbortController()
    this.requests.add(requestController)
    const onAbort = (): void => requestController.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => requestController.abort(), REQUEST_TIMEOUT_MS)
    timeout.unref()
    try {
      const form = new FormData()
      form.append('file', new Blob([wav as unknown as BlobPart], { type: 'audio/wav' }), 'input.wav')
      form.append('language', options.language.trim().toLowerCase() === 'auto' ? 'auto' : 'en')
      form.append('no_timestamps', 'true')
      form.append('response_format', 'json')
      form.append('temperature', '0')
      form.append('temperature_inc', '0.2')
      const vocabulary = options.vocabulary.trim()
      // Send prompt on every request so a prior non-empty request cannot
      // affect a later empty-prompt request on older server builds.
      form.append('prompt', vocabulary.slice(0, 4_000))

      let response: Response
      try {
        response = await fetch(`${this.baseUrl}/inference`, {
          method: 'POST',
          body: form,
          signal: requestController.signal,
          redirect: 'error'
        })
      } catch (error) {
        if (signal.aborted) throw abortError()
        if (requestController.signal.aborted) throw new WhisperServerRequestError('The local Whisper server request timed out.')
        throw new WhisperServerUnavailableError(error instanceof Error ? error.message : 'The local Whisper server could not be reached.')
      }

      const body = await response.text()
      if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new WhisperServerRequestError('The local Whisper server returned too much text.')
      }
      if (!response.ok) {
        if (response.status === 400) throw new WhisperServerInvalidAudioError(body.slice(0, 200) || undefined)
        throw new WhisperServerRequestError(`The local Whisper server returned HTTP ${response.status}.`)
      }
      let parsed: unknown
      try { parsed = JSON.parse(body) } catch { throw new WhisperServerRequestError('The local Whisper server returned invalid JSON.') }
      const text = parsed && typeof parsed === 'object' && typeof (parsed as { text?: unknown }).text === 'string'
        ? (parsed as { text: string }).text
        : ''
      if (!text.trim()) throw new WhisperServerRequestError('The local Whisper server returned no transcript.')
      return text
    } catch (error) {
      if (signal.aborted) {
        await this.stop()
        throw abortError()
      }
      if (requestController.signal.aborted) {
        await this.stop()
        throw new WhisperServerRequestError('The local Whisper server request timed out.')
      }
      throw error
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      this.requests.delete(requestController)
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopped = true
    this.stopPromise = (async () => {
      for (const request of this.requests) request.abort()
      await stopChild(this.child)
      await rm(this.publicDirectory, { recursive: true, force: true })
    })()
    return this.stopPromise
  }
}

export async function warmWhisperServer(options: WhisperServerStartOptions): Promise<WhisperServerHandle> {
  throwIfAborted(options.signal)
  await requireFile(options.executable, 'Whisper', true)
  await requireFile(options.modelPath, 'Whisper model')

  const publicDirectory = await mkdtemp(join(tmpdir(), 'terry-whisper-server-'))
  await chmod(publicDirectory, 0o700)
  const port = await freeLoopbackPort()
  const args = [
    '-m', options.modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--public', publicDirectory,
    '-nt',
    '-bs', '5',
    '-bo', '5',
    '-fa'
  ]
  const child = spawn(options.executable, args, { shell: false, stdio: 'ignore', windowsHide: true })
  try {
    await waitForServer(child, `http://127.0.0.1:${port}`, options.startupTimeoutMs ?? DEFAULT_START_TIMEOUT_MS, options.signal)
    return new LocalWhisperServer(child, port, publicDirectory)
  } catch (error) {
    await stopChild(child)
    await rm(publicDirectory, { recursive: true, force: true })
    throw error
  }
}

export async function stopWhisperServer(
  server: WhisperServerHandle | Promise<WhisperServerHandle> | null | undefined,
  startupController?: AbortController
): Promise<void> {
  startupController?.abort()
  if (!server) return
  if (typeof server === 'object' && 'then' in server && typeof server.then === 'function') {
    await Promise.resolve(server).then(handle => handle.stop()).catch(() => undefined)
    return
  }
  await (server as WhisperServerHandle).stop()
}
