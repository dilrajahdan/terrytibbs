// Opt-in native integration: owned editable target, software speech microphone,
// actual speech engine + paste helper. Does not synthesize physical key events.
// Run after npm run build and node scripts/e2e-fixtures.mjs. Needs Accessibility.
import { _electron as electron, expect } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'

const directory = await mkdtemp(join(tmpdir(), 'terry-native-delivery-'))
const fixturePath = resolve('artifacts/clipboard-fixture')
execFileSync('swiftc', ['scripts/clipboard-fixture.swift', '-O', '-o', fixturePath])
const fixture = spawn(fixturePath, [], { stdio: ['pipe', 'pipe', 'inherit'] })
const lines = createInterface({ input: fixture.stdout })[Symbol.asyncIterator]()
const receive = async () => JSON.parse((await lines.next()).value)
const checkClipboard = async () => { fixture.stdin.write('check\n'); return (await receive()).matches }
if (!(await receive()).ready) throw Error('Clipboard observer unavailable')
let app, editor
try {
  await writeFile(join(directory, 'settings.json'), JSON.stringify({
    whisperPath: '/opt/homebrew/bin/whisper-cli', modelPath: process.env.TERRY_TEST_MODEL || resolve('artifacts/ggml-tiny.en.bin'),
    shortcut: 'Alt+Space', language: 'en', vocabulary: '', autoPaste: true, muteOtherAudio: false, keepMicrophoneReady: false,
    cleanupEnabled: false, cleanupModel: '', activationSound: 'off', activationSoundDirectory: '', activationSoundClip: '', microphoneId: '', microphoneLabel: '',
    correctionsEnabled: true, corrections: [{ from: 'country', to: 'Country' }]
  }))
  app = await electron.launch({ args: ['.'], env: { ...process.env, TERRY_E2E: '1', TERRY_USER_DATA: directory, TERRY_E2E_NATIVE_HELPER: resolve('build/terry-native') } })
  // Native successful paste handles its own preservation. Intercept only the
  // fallback copy path so a failed test cannot overwrite the real clipboard.
  await app.evaluate(({ clipboard, systemPreferences }) => {
    clipboard.writeText = async () => undefined
    systemPreferences.getMediaAccessStatus = () => 'granted'
  })
  await expect.poll(() => app.windows().filter(page => page.url().includes('index.html') && !page.url().endsWith('#hud')).length).toBe(1)
  const page = app.windows().find(page => page.url().includes('index.html') && !page.url().endsWith('#hud'))
  await page.evaluate(bytes => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(), source = context.createBufferSource(), output = context.createMediaStreamDestination()
      source.buffer = await context.decodeAudioData(Uint8Array.from(bytes).buffer)
      source.connect(output); await context.resume(); source.start()
      const track = output.stream.getAudioTracks()[0], stop = track.stop.bind(track)
      track.stop = () => { stop(); source.stop(); void context.close() }
      return output.stream
    }
  }, Array.from(await readFile('artifacts/jfk.wav')))
  editor = await electron.launch({ args: ['scripts/tutorial/demo-editor.cjs'], env: { ...process.env, TERRY_EDITOR_DATA: join(directory, 'editor') } })
  const target = await editor.firstWindow(), field = target.getByRole('textbox', { name: 'Note' })
  await target.waitForLoadState('domcontentloaded')
  const state = () => page.evaluate(() => window.terry.getState())
  // Cancel immediately before a new dictation, so stale capture cannot deliver.
  await app.evaluate(() => { globalThis.__terryHotkey({ type: 'down' }); globalThis.__terryHotkey({ type: 'cancel' }) })
  await expect.poll(() => state().then(state => state.phase)).toBe('ready')
  for (const mode of ['hold', 'locked']) {
    await field.fill('')
    await editor.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus() })
    await field.click()
    await app.evaluate((_electron, mode) => {
      const edge = globalThis.__terryHotkey
      edge({ type: 'down' })
      if (mode === 'locked') { edge({ type: 'up' }); edge({ type: 'down' }); edge({ type: 'up' }) }
    }, mode)
    await expect.poll(() => state().then(state => state.phase)).toBe('recording')
    if ((await state()).recordingMode !== mode) throw Error('Wrong gesture mode')
    await new Promise(resolve => setTimeout(resolve, 11_700))
    await app.evaluate((_electron, mode) => {
      const edge = globalThis.__terryHotkey
      edge({ type: mode === 'hold' ? 'up' : 'down' }); if (mode === 'locked') edge({ type: 'up' })
    }, mode)
    await expect.poll(() => state().then(state => state.phase), { timeout: 30_000 }).toBe('ready')
    const result = await state()
    if (result.delivery !== 'sent') throw Error(result.message)
    await expect(field).toHaveValue(result.transcript.text)
    if (!/^and so.*fellow Americans/i.test(result.transcript.text) || !result.transcript.text.includes('Country')) throw Error('Opening words or confirmed correction missing')
    if (!await checkClipboard()) throw Error('Clipboard changed during integration run; no external copy is overwritten by this observer')
    console.log(`${mode}: actual insertion, corrected text and original clipboard verified`)
  }
} finally {
  // Observer never seeds/restores the clipboard, so concurrent user copies win.
  fixture.stdin.end()
  if (editor) await editor.close()
  if (app) await app.close()
  await rm(directory, { recursive: true, force: true })
}
