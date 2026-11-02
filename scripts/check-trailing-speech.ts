// Real local-model regression. Run e2e-fixtures.mjs first, then:
// TERRY_TEST_MODEL=/absolute/model.bin npx tsx scripts/check-trailing-speech.ts
// Optional independent spoken-thanks control: TERRY_TEST_THANKS_WAV=/path/file.wav
// with TERRY_TEST_THANKS_REFERENCE containing its verified reference words.
// Never records a microphone or reads personal preferences/clipboard.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import { defaultSettings } from '../src/main/settings'
import { pcmToWav, transcribeWav, trimTrailingNonSpeech, validateWav } from '../src/main/speech'
import { requireSpeech } from '../src/main/voice-activity'
import { warmWhisperServer } from '../src/main/whisper-server'

function samples(wav: Buffer): Float32Array {
  validateWav(wav)
  for (let offset = 12; offset < wav.length;) {
    const size = wav.readUInt32LE(offset + 4), start = offset + 8
    if (wav.toString('ascii', offset, offset + 4) === 'data') {
      return Float32Array.from({ length: size / 2 }, (_, i) => wav.readInt16LE(start + i * 2) / 32768)
    }
    offset = start + size + (size & 1)
  }
  throw Error('No PCM data')
}
const words = (text: string) => text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? []
async function main() {
  assert.ok(process.env.TERRY_TEST_MODEL, 'Set TERRY_TEST_MODEL to a local model')
  const settings = { ...defaultSettings(resolve('artifacts/unused')), modelPath: resolve(process.env.TERRY_TEST_MODEL!) }
  const signal = AbortSignal.timeout(240_000)
  const source = await readFile('artifacts/jfk.wav')
  assert.equal(createHash('sha256').update(source).digest('hex'), '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e')
  const controls = [{ name: 'public-speech', wav: source, reference: 'And so my fellow Americans ask not what your country can do for you ask what you can do for your country' }]
  if (process.env.TERRY_TEST_THANKS_WAV) {
    assert.ok(process.env.TERRY_TEST_THANKS_REFERENCE, 'Spoken-thanks fixture requires a verified reference')
    controls.push({ name: 'spoken-thanks', wav: await readFile(process.env.TERRY_TEST_THANKS_WAV), reference: process.env.TERRY_TEST_THANKS_REFERENCE! })
  }
  const server = await warmWhisperServer({ executable: resolve(settings.whisperPath, '../whisper-server'), modelPath: settings.modelPath, signal })
  const rows: object[] = []
  try {
    for (const control of controls) {
      const known = await transcribeWav(control.wav, settings, signal, server)
      assert.deepEqual(words(known.raw), words(control.reference), 'Known-good control must pass before interpreting modified audio')
      for (const variant of ['silence', 'noise', 'quiet-ending']) {
        const original = samples(control.wav), audio = new Float32Array(original.length + 25 * 16000)
        audio.set(original)
        if (variant === 'quiet-ending') {
          for (let i = Math.max(0, original.length - 2 * 16000); i < original.length; i++) audio[i] *= .1
        }
        if (variant === 'noise') {
          let seed = 42
          for (let i = original.length; i < audio.length; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
            audio[i] = (seed / 4294967296 * 2 - 1) * .005
          }
        }
        const wav = pcmToWav(audio)
        const segments = await requireSpeech(wav, settings.whisperPath, resolve('resources/ggml-silero-v6.2.0.bin'), signal)
        const endMs = segments.at(-1)!.endMs
        for (let round = 0; round < 2; round++) {
          for (const bounded of round ? [true, false] : [false, true]) {
            const start = performance.now()
            const result = await transcribeWav(wav, settings, signal, server, bounded ? endMs : undefined)
            const row = { sample: control.name, variant, bounded, round, ms: Math.round(performance.now() - start),
              inputMs: validateWav(wav).durationMs, recognitionMs: validateWav(bounded ? trimTrailingNonSpeech(wav,endMs) : wav).durationMs, text: result.raw }
            rows.push(row)
            console.log(JSON.stringify(row))
            if (bounded) assert.deepEqual(words(result.raw), words(control.reference), `${control.name}/${variant}: preserve all spoken words without added endings`)
          }
        }
      }
    }
  } finally {
    await server.stop()
    await writeFile('artifacts/trailing-speech-check.json', JSON.stringify({ model: basename(settings.modelPath), rows,
      limitations: 'Public speech with artificial tails and attenuation; warm recognition only, no physical microphone. Two paired rounds do not establish general accuracy or latency.' }, null, 2))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
