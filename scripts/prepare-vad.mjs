import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

// Upstream ggml conversion of Silero VAD 6.2.0 (MIT). Download at build time,
// never during dictation. Keep source checkouts small and packages offline.
export const VAD_NAME = 'ggml-silero-v6.2.0.bin'
const bytes = 885098
const sha256 = '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987'
const url = `https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/${VAD_NAME}`
const destination = resolve('resources', VAD_NAME)
const valid = value => value.length === bytes && createHash('sha256').update(value).digest('hex') === sha256
let existing
try { existing = await readFile(destination) } catch {}
if (!existing || !valid(existing)) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok || !response.body) throw new Error(`Speech detector download failed (${response.status}).`)
  const chunks = []; let received = 0
  for await (const chunk of response.body) {
    received += chunk.length
    if (received > bytes) throw new Error('Speech detector download exceeded its expected size.')
    chunks.push(chunk)
  }
  const model = Buffer.concat(chunks)
  if (!valid(model)) throw new Error('Speech detector checksum did not match.')
  await mkdir(resolve('resources'), { recursive: true })
  const temporary = `${destination}.${process.pid}.partial`
  try { await writeFile(temporary, model); await rename(temporary, destination) }
  finally { await rm(temporary, { force: true }) }
}
console.log('Offline speech detector verified.')
