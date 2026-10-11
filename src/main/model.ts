import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const MODEL_NAME = 'ggml-large-v3-turbo.bin'
export const MODEL_BYTES = 1624555275
export const MODEL_SHA256 = '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69'
export const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/' + MODEL_NAME

export async function downloadModelFile(destination: string, progress: (percent: number) => void, signal?: AbortSignal): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = destination + '.partial'
  try {
    const response = await fetch(MODEL_URL, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]) : AbortSignal.timeout(30 * 60_000) })
    if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status}). Please retry.`)
    let bytes = 0
    let lastPercent = -1
    const hash = createHash('sha256')
    const tracker = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > MODEL_BYTES) return callback(new Error('Model download exceeded expected size.'))
      hash.update(chunk)
      const percent = Math.floor(bytes / MODEL_BYTES * 100)
      if (percent !== lastPercent) { lastPercent = percent; progress(percent) }
      callback(null, chunk)
    } })
    await pipeline(Readable.fromWeb(response.body as never), tracker, createWriteStream(temporary, { mode: 0o600 }), { signal })
    if (bytes !== MODEL_BYTES || hash.digest('hex') !== MODEL_SHA256) throw new Error('Model checksum did not match. Please retry the download.')
    await rename(temporary, destination)
  } finally { await rm(temporary, { force: true }) }
}

export async function verifyDefaultModel(path: string): Promise<boolean> {
  try {
    if ((await stat(path)).size !== MODEL_BYTES) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex') === MODEL_SHA256
  } catch { return false }
}
