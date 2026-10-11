import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const VAD_MODEL_NAME = 'ggml-silero-v6.2.0.bin'
export class NoSpeechError extends Error {
  constructor() {
    super('No speech detected. Nothing copied or pasted.')
    this.name = 'NoSpeechError'
  }
}

export function hasSpeechSegments(output: string): boolean {
  const lines = output.trim().split(/\r?\n/)
  const header = /^Detected (\d+) speech segments:$/.exec(lines[0] ?? '')
  const count = header ? Number(header[1]) : -1
  if (count < 0 || count > 1000 || lines.length !== count + 1) {
    throw new Error('The speech detector returned an invalid result. Nothing was pasted.')
  }
  for (let index = 0; index < count; index++) {
    const match = /^Speech segment (\d+): start = (\d+(?:\.\d+)?), end = (\d+(?:\.\d+)?)$/.exec(lines[index + 1])
    if (!match || Number(match[1]) !== index || !Number.isFinite(Number(match[3])) || Number(match[3]) <= Number(match[2])) {
      throw new Error('The speech detector returned an invalid segment. Nothing was pasted.')
    }
  }
  return count > 0
}

async function detect(executable: string, args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = '', failure: Error | undefined, settled = false
    let killTimer: NodeJS.Timeout | undefined
    const terminate = (error: Error) => {
      if (settled || failure) return
      failure = error
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000)
      killTimer.unref()
    }
    const abort = () => terminate(Object.assign(new Error('Operation cancelled'), { name: 'AbortError' }))
    const timer = setTimeout(() => terminate(new Error('The speech detector timed out. Nothing was pasted.')), 15_000)
    timer.unref()
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer); clearTimeout(killTimer)
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(output)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (output.length + chunk.length > 65_536) terminate(new Error('The speech detector returned too much data. Nothing was pasted.'))
      else output += chunk
    })
    child.once('error', () => finish(failure ?? new Error('The speech detector could not start. Nothing was pasted.')))
    child.once('close', code => finish(failure ?? (code === 0 ? undefined : new Error('The speech detector failed. Nothing was pasted.'))))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

// Run independently of Whisper so a prompt cannot turn non-speech into words.
// Only classify the audio: retain the entire original recording for recognition.
export async function requireSpeech(wav: Buffer, whisperPath: string, modelPath: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const executable = join(dirname(whisperPath), 'whisper-vad-speech-segments')
  try { await access(executable, constants.X_OK); await access(modelPath, constants.R_OK) }
  catch { throw new Error('Speech detection is unavailable. Update whisper.cpp with Homebrew and reinstall Terry. Nothing was pasted.') }
  const directory = await mkdtemp(join(tmpdir(), 'terry-vad-'))
  try {
    await chmod(directory, 0o700)
    const input = join(directory, 'input.wav')
    await writeFile(input, wav, { mode: 0o600 })
    const output = await detect(executable, ['-np', '-t', '2', '-vm', modelPath, '-f', input, '-vspd', '120'], signal)
    signal.throwIfAborted()
    if (!hasSpeechSegments(output)) throw new NoSpeechError()
  } finally { await rm(directory, { recursive: true, force: true }) }
}
