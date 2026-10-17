// Public recordings only. Does not use the microphone, clipboard, app settings or remote inference.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { totalmem } from 'node:os'
import { createInterface } from 'node:readline'
import { performance } from 'node:perf_hooks'
import { defaultSettings } from '../src/main/settings'
import { transcribeWav } from '../src/main/speech'
import { warmWhisperServer, type WhisperServerHandle } from '../src/main/whisper-server'

type Sample = { id: string; subset: string; speaker: number; reference: string; durationMs: number; wav: string; sourceSha256: string; wavSha256: string }
type Row = { engine: string; id: string; subset: string; round: number; ms: number; wordErrors: number; referenceWords: number; firstWord: boolean; firstThreeWords: boolean; text: string }
type HelperMessage = { type: string; id?: string; text?: string; error?: string; loadMs?: number }
const cache = resolve('artifacts/model-comparison')
const engines = ['whisper-turbo', 'parakeet-v3'] as const
const words = (text: string): string[] => text.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9]+(?:'[a-z]+)*/g) ?? []

function score(reference: string, actual: string) {
  const expected = words(reference), observed = words(actual)
  let row = Array.from({ length: observed.length + 1 }, (_, i) => i)
  for (let i = 1; i <= expected.length; i++) {
    const next = [i]
    for (let j = 1; j <= observed.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(expected[i - 1] !== observed[j - 1]))
    row = next
  }
  return { wordErrors: row[observed.length], referenceWords: expected.length, firstWord: expected[0] === observed[0],
    firstThreeWords: expected.slice(0, 3).join(' ') === observed.slice(0, 3).join(' ') }
}
const quantile = (values: number[], fraction: number): number => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)]
async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function modelFiles(directory: string, prefix = ''): Promise<Array<{ file: string; bytes: number; sha256: string }>> {
  const files: Array<{ file: string; bytes: number; sha256: string }> = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name), file = prefix + entry.name
    if (entry.isDirectory()) files.push(...await modelFiles(path, file + '/'))
    else if (entry.isFile()) files.push({ file, bytes: (await stat(path)).size, sha256: await sha256(path) })
  }
  return files
}

async function startParakeet() {
  const start = performance.now()
  const child = spawn(resolve(cache, 'swift-build/release/TerryParakeetBenchmark'), ['serve', resolve(cache, 'models')], { stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map<string, { resolve: (value: HelperMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let diagnostics = ''
  child.stderr.on('data', data => { diagnostics = (diagnostics + String(data)).slice(-4000) })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  let readyResolve!: (value: HelperMessage) => void, readyReject!: (error: Error) => void
  const ready = new Promise<HelperMessage>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const startupTimeout = setTimeout(() => readyReject(new Error('Parakeet startup exceeded 180 seconds')), 180_000)
  const output = createInterface({ input: child.stdout })
  const fail = (error: Error) => {
    clearTimeout(startupTimeout)
    readyReject(error)
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }
    pending.clear()
  }
  child.once('error', fail)
  child.stdin.on('error', fail)
  child.once('close', code => fail(new Error(`Parakeet exited ${code}. ${diagnostics}`)))
  output.on('line', line => {
    let message: HelperMessage
    try { message = JSON.parse(line) } catch { return }
    if (message.type === 'ready') { clearTimeout(startupTimeout); readyResolve(message); return }
    if (!message.id && message.type === 'error') { fail(new Error(message.error)); return }
    const item = pending.get(message.id ?? '')
    if (!item) return
    pending.delete(message.id!)
    clearTimeout(item.timer)
    if (message.type === 'error') item.reject(new Error(message.error))
    else item.resolve(message)
  })
  const stop = async () => {
    child.stdin.end() // EOF requests orderly exit; no broad process matching or kill.
    let timer: ReturnType<typeof setTimeout> | undefined
    const exited = await Promise.race([closed.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 10_000) })])
    clearTimeout(timer)
    if (!exited && child.pid && child.exitCode === null) {
      const processInfo = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).trim()
      const [pid, ppid] = processInfo.split(/\s+/)
      assert.equal(Number(pid), child.pid)
      assert.equal(Number(ppid), process.pid)
      console.error(`Stopping unresponsive owned Parakeet helper ${pid} (parent ${ppid}).`)
      child.kill('SIGTERM')
      await closed
    }
    output.close()
  }
  try {
    const metadata = await ready
    return {
      metadata, startupMs: Math.round(performance.now() - start), stop,
      async transcribe(wav: string, id: string): Promise<string> {
        const message = await new Promise<HelperMessage>((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error('Parakeet request exceeded 120 seconds')) }, 120_000)
          pending.set(id, { resolve, reject, timer })
          child.stdin.write(JSON.stringify({ id, wav }) + '\n')
        })
        return message.text ?? ''
      }
    }
  } catch (error) { await stop(); throw error }
}

async function main() {
  if (!process.argv[2]) throw new Error('Usage: npx tsx scripts/benchmark-models.ts /absolute/path/to/ggml-large-v3-turbo.bin')
  // A failed new run must not leave an old passing report under the output name.
  await rm(resolve(cache, 'results.json'), { force: true })
  await rm(resolve(cache, 'results-public.json'), { force: true })
  // Scoring controls: deletion, insertion and substitution must each count once.
  assert.equal(score('one two three', 'one three').wordErrors, 1)
  assert.equal(score('one two three', 'one extra two three').wordErrors, 1)
  assert.equal(score('one two three', 'one four three').wordErrors, 1)
  assert.equal(score("DON'T stop.", "Don’t stop!").wordErrors, 0)
  const manifest = JSON.parse(await readFile(resolve(cache, 'manifest.json'), 'utf8')) as {
    control: { wav: string; sha256: string; reference: string }; samples: Sample[]; selection: string; source: string; license: string; archiveMd5: Record<string, string>
  }
  for (const sample of manifest.samples) assert.equal(await sha256(resolve(cache, sample.wav)), sample.wavSha256, `Fixture changed: ${sample.id}`)
  const controlPath = resolve(cache, manifest.control.wav)
  assert.equal(await sha256(controlPath), manifest.control.sha256, 'Public speech control changed')
  const settings = { ...defaultSettings(resolve(cache, 'unused-settings')), modelPath: resolve(process.argv[2]) }
  const modelSha256 = await sha256(settings.modelPath)
  let whisper: WhisperServerHandle | undefined
  let parakeet: Awaited<ReturnType<typeof startParakeet>> | undefined
  const rows: Row[] = []
  try {
    const start = performance.now()
    whisper = await warmWhisperServer({ executable: resolve(settings.whisperPath, '../whisper-server'), modelPath: settings.modelPath })
    const whisperStartupMs = Math.round(performance.now() - start)
    parakeet = await startParakeet()
    const transcribe = async (engine: string, path: string, id: string) => engine === 'whisper-turbo'
      ? (await transcribeWav(await readFile(path), settings, AbortSignal.timeout(120_000), whisper)).raw
      : await parakeet!.transcribe(path, id)
    const firstInferenceMs: Record<string, number> = {}
    for (const engine of engines) {
      const start = performance.now()
      const text = await transcribe(engine, controlPath, 'control-' + engine)
      firstInferenceMs[engine] = Math.round(performance.now() - start)
      assert.equal(score(manifest.control.reference, text).wordErrors, 0, `Known-good speech control failed for ${engine}: ${text}`)
    }
    for (let round = 0; round < 3; round++) {
      const samples = round % 2 ? [...manifest.samples].reverse() : manifest.samples
      for (let index = 0; index < samples.length; index++) {
        const sample = samples[index]
        const order = (round + index) % 2 ? [...engines].reverse() : engines
        for (const engine of order) {
          const start = performance.now()
          const text = await transcribe(engine, resolve(cache, sample.wav), `${round}-${sample.id}-${engine}`)
          const ms = Math.round(performance.now() - start)
          rows.push({ engine, id: sample.id, subset: sample.subset, round, ms, ...score(sample.reference, text), text })
        }
      }
      console.error(`Completed paired round ${round + 1}/3 (${samples.length} public clips).`)
    }
    const summary = engines.flatMap(engine => ['test-clean', 'test-other', 'all'].map(subset => {
      const selected = rows.filter(row => row.engine === engine && (subset === 'all' || row.subset === subset))
      const unique = selected.filter(row => row.round === 0)
      const errors = unique.reduce((sum, row) => sum + row.wordErrors, 0), referenceWords = unique.reduce((sum, row) => sum + row.referenceWords, 0)
      return { engine, subset, clips: unique.length, timingRuns: selected.length, wordErrors: errors, referenceWords,
        werPercent: Number((errors / referenceWords * 100).toFixed(2)), firstWord: unique.filter(row => row.firstWord).length,
        firstThreeWords: unique.filter(row => row.firstThreeWords).length, medianMs: quantile(selected.map(row => row.ms), 0.5),
        p95Ms: quantile(selected.map(row => row.ms), 0.95), maxMs: Math.max(...selected.map(row => row.ms)),
        repeatTranscriptsStable: unique.every(row => selected.filter(candidate => candidate.id === row.id).every(candidate => words(candidate.text).join(' ') === words(row.text).join(' '))) }
    }))
    const report = {
      schema: 1, recordedAt: new Date().toISOString(),
      hardware: { chip: execFileSync('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(), memoryBytes: totalmem(),
        macOS: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim() },
      whisper: { package: execFileSync('/opt/homebrew/bin/brew', ['list', '--versions', 'whisper.cpp'], {
        encoding: 'utf8', env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_FROM_API: '1' }
      }).trim(),
        model: basename(settings.modelPath), modelSha256, startupMs: whisperStartupMs, firstInferenceMs: firstInferenceMs['whisper-turbo'] },
      parakeet: { fluidAudioVersion: '0.17.7', fluidAudioRevision: '503b4bd1bbf7220882de39fe8ae6716aae4132da',
        ...parakeet.metadata, startupMs: parakeet.startupMs, firstInferenceMs: firstInferenceMs['parakeet-v3'], modelFiles: await modelFiles(resolve(cache, 'models')) },
      dataset: { source: manifest.source, license: manifest.license, selection: manifest.selection, archiveMd5: manifest.archiveMd5,
        samples: manifest.samples.map(({ wav: _wav, reference: _reference, ...sample }) => sample) },
      controlPassed: true, summary, rows,
      timing: 'Warm wall-clock recognizer request including disk read, PCM conversion and IPC/HTTP. Startup and first inference reported separately. Both models resident, serial inference, alternating engine order and reversed clip order in round 2. Three rounds. No capture, speech detection, cues, cleanup or paste. Normal desktop workload; OS caches not flushed, so startup is not cold boot.',
      scoring: 'Lowercase ASCII words and digits, curly apostrophes normalized; ignore other punctuation. Apostrophes inside contractions retained; hyphens split. No number-format equivalence or synonym correction. WER and first-word results use first round only, not repeated clips as independent evidence. First-word/first-three means exact prefix match.',
      limitations: '20 short audiobook utterances from 20 public speakers, selected before recognition. Read speech is not spontaneous dictation, personal names or real mumbling. Common public benchmark data may overlap model training. No physical microphone or beginning-capture verification. Results do not justify a production model switch without representative local user speech.'
    }
    await writeFile(resolve(cache, 'results.json'), JSON.stringify(report, null, 2) + '\n')
    // A shareable result has metrics, public sample IDs and checksums, but no transcripts or filesystem paths.
    const publicReport = { ...report, rows: rows.map(({ text: _text, ...row }) => row) }
    await writeFile(resolve(cache, 'results-public.json'), JSON.stringify(publicReport, null, 2) + '\n')
    console.log(JSON.stringify({ startup: { whisperMs: whisperStartupMs, parakeetMs: parakeet.startupMs }, firstInferenceMs, summary }, null, 2))
  } finally {
    await parakeet?.stop()
    if (whisper?.running) {
      // Verify ownership before stopping only the process this run started.
      const processInfo = execFileSync('/bin/ps', ['-p', String(whisper.pid), '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).trim()
      const [pid, ppid] = processInfo.split(/\s+/)
      assert.equal(Number(pid), whisper.pid)
      assert.equal(Number(ppid), process.pid)
      console.error(`Stopping owned benchmark Whisper server ${pid} (parent ${ppid}).`)
      await whisper.stop()
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
