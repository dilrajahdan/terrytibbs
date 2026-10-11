// Public JFK fixture only. Does not open a microphone or touch user settings.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { basename, resolve } from 'node:path'
import { totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { transcribeWav } from '../src/main/speech'
import { defaultSettings } from '../src/main/settings'
import { warmWhisperServer, type WhisperServerHandle } from '../src/main/whisper-server'

async function main(): Promise<void> {
  const model = process.argv[2]
  if (!model) throw new Error('Usage: npx tsx scripts/benchmark-speech.ts /absolute/path/to/ggml-model.bin')
  const wav = await readFile(resolve('artifacts/jfk.wav'))
  const sampleHash = createHash('sha256').update(wav).digest('hex')
  if (sampleHash !== '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e') {
    throw new Error('Expected the public whisper.cpp JFK fixture. Run node scripts/e2e-fixtures.mjs.')
  }
  const settings = { ...defaultSettings(resolve('artifacts/unused-benchmark-settings')), modelPath: resolve(model) }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(settings.modelPath)) hash.update(chunk)
  const expected = 'and so my fellow americans ask not what your country can do for you ask what you can do for your country'
  const check = (raw: string): void => {
    if (raw.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim() !== expected) {
      throw new Error('The reference words did not match. No passing timing report was produced.')
    }
  }
  const signal = AbortSignal.timeout(180_000)
  const cliMs: number[] = []
  const warmMs: number[] = []
  let server: WhisperServerHandle | undefined
  try {
    for (let i = 0; i < 3; i++) {
      const start = performance.now()
      check((await transcribeWav(wav, settings, signal)).raw)
      cliMs.push(Math.round(performance.now() - start))
    }
    const start = performance.now()
    server = await warmWhisperServer({
      executable: resolve(settings.whisperPath, '../whisper-server'),
      modelPath: settings.modelPath,
      signal
    })
    const serverStartupMs = Math.round(performance.now() - start)
    for (let i = 0; i < 5; i++) {
      const start = performance.now()
      check((await transcribeWav(wav, settings, signal, server)).raw)
      warmMs.push(Math.round(performance.now() - start))
    }
    console.log(JSON.stringify({
      schema: 1,
      recordedAt: new Date().toISOString(),
      chip: execFileSync('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(),
      memoryBytes: totalmem(),
      macOS: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
      enginePackage: execFileSync('/opt/homebrew/bin/brew', ['list', '--versions', 'whisper.cpp'], { encoding: 'utf8' }).trim(),
      model: basename(settings.modelPath),
      modelSha256: hash.digest('hex'),
      sample: 'whisper.cpp public JFK sample', sampleSha256: sampleHash, sampleDurationMs: 11000,
      cliMs, serverStartupMs, warmMs,
      referenceWordsMatch: true,
      conditions: 'Normal desktop workload; model read for SHA-256 before timing, so OS file cache is warm. CLI runs precede server runs. Server startup is excluded from request timings. English, empty vocabulary, cleanup off. No physical microphone or paste timing. One sample, no accuracy generalisation.'
    }, null, 2))
  } finally {
    await server?.stop()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
