import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultSettings } from '../../src/main/settings'

type HelperEvent = { type: string; pid?: number; at?: number; index?: number }

async function helperEvents(path: string): Promise<HelperEvent[]> {
  const content = await readFile(path, 'utf8')
  return content.trim() ? content.trim().split('\n').map(line => JSON.parse(line) as HelperEvent) : []
}

async function installDelayedHelper(directory: string, logPath: string): Promise<string> {
  const helper = join(directory, 'native helper ; literal.cjs')
  const countPath = join(directory, 'frontmost-count')
  await writeFile(helper, `#!${process.execPath}
const fs = require('node:fs')
const command = process.argv[2]
const logPath = ${JSON.stringify(logPath)}
const countPath = ${JSON.stringify(countPath)}
const log = value => fs.appendFileSync(logPath, JSON.stringify({ ...value, at: Date.now() }) + '\\n')
if (command === 'frontmost') {
  const index = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : '0') + 1
  fs.writeFileSync(countPath, String(index))
  const pid = index === 2 ? 222 : 111
  const delay = 2500
  process.on('SIGTERM', () => { log({ type: 'frontmost-abort', index, pid }); process.exit(0) })
  log({ type: 'frontmost-start', index, pid })
  setTimeout(() => {
    log({ type: 'frontmost-end', index, pid })
    process.stdout.write(JSON.stringify({ trusted: true, pid, name: 'Fake editor', bundleId: 'dev.fake.editor', editable: true, focus: 'editable' }) + '\\n')
  }, delay)
} else if (command === 'paste-preserving') {
  const pid = Number(process.argv[3])
  log({ type: 'paste', pid })
  process.stdout.write('{"ok":true}\\n')
} else {
  process.stdout.write('{"ok":false,"reason":"unavailable"}\\n')
  process.exitCode = 1
}
`)
  await chmod(helper, 0o700)
  return helper
}

async function installSpeechSource(page: Page): Promise<void> {
  await page.evaluate(bytes => {
    ;(window as any).__micStarts = []
    ;(window as any).__captureStops = []
    window.terry.onCapture(command => {
      if (command.action === 'stop') (window as any).__captureStops.push(command.sessionId)
    })
    navigator.mediaDevices.getUserMedia = async () => {
      ;(window as any).__micStarts.push(Date.now())
      const request = (window as any).__micStarts.length
      await new Promise(resolve => setTimeout(resolve, request === 2 ? 400 : 3_000))
      const context = new AudioContext()
      const source = context.createBufferSource()
      source.buffer = await context.decodeAudioData(Uint8Array.from(bytes).buffer)
      source.loop = true
      const destination = context.createMediaStreamDestination()
      source.connect(destination)
      await context.resume()
      source.start()
      const track = destination.stream.getAudioTracks()[0]
      const stop = track.stop.bind(track)
      track.stop = () => { stop(); source.stop(); void context.close() }
      return destination.stream
    }
  }, Array.from(await readFile('artifacts/jfk.wav')))
}

test('capture starts before delayed focus lookup and cancelled sessions cannot replace its destination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-lock-paste-'))
  const logPath = join(directory, 'helper-events.jsonl')
  await mkdir('artifacts', { recursive: true })
  await writeFile(logPath, '')
  const helper = await installDelayedHelper(directory, logPath)
  await writeFile(join(directory, 'settings.json'), JSON.stringify({
    ...defaultSettings(directory), muteOtherAudio: false,
    modelPath: resolve('artifacts/ggml-tiny.en.bin'),
    autoPaste: true
  }))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TERRY_E2E: '1', TERRY_USER_DATA: directory, TERRY_E2E_NATIVE_HELPER: helper }
  })
  try {
    await expect.poll(() => app.windows().filter(page => page.url().includes('index.html') && !page.url().endsWith('#hud')).length).toBe(1)
    const page = app.windows().find(page => page.url().includes('index.html') && !page.url().endsWith('#hud'))!
    await installSpeechSource(page)
    const hud = app.windows().find(page => page.url().endsWith('#hud'))!
    const phase = () => page.evaluate(() => window.terry.getState().then(state => state.phase))
    const state = () => page.evaluate(() => window.terry.getState())
    const microphones = () => page.evaluate(() => (window as any).__micStarts as number[])
    const captureStops = () => page.evaluate(() => (window as any).__captureStops as number[])
    const edge = (type: string) => app.evaluate((_electron, type) => (globalThis as any).__terryHotkey({ type }), type)

    await expect(page.getByRole('button', { name: 'Start dictation', exact: true })).toBeEnabled()

    // Establish that the delayed helper really started before cancelling the
    // first held startup. A cancelled spawn need not ever run its script.
    await edge('down')
    await expect.poll(() => helperEvents(logPath).then(events => events.filter(event => event.type === 'frontmost-start').length)).toBe(1)
    await edge('up')
    await expect.poll(phase).toBe('ready')
    expect((await helperEvents(logPath)).filter(event => event.type === 'frontmost-end')).toHaveLength(0)

    // The second session locks before its 2.5 second snapshot returns. The HUD
    // must already expose the lock state and be visible while starting.
    await app.evaluate(() => { for (const type of ['down', 'up', 'down', 'up']) (globalThis as any).__terryHotkey({ type }) })
    await expect.poll(phase).toBe('starting')
    await expect.poll(() => helperEvents(logPath).then(events => events.filter(event => event.type === 'frontmost-start').length)).toBe(2)
    await expect(hud.locator('.hud-lock')).toBeVisible()
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#hud'))!.isVisible())).toBe(true)
    expect((await helperEvents(logPath)).filter(event => event.type === 'frontmost-end')).toHaveLength(0)
    await hud.screenshot({ path: 'artifacts/hud-lock-starting.png' })

    await expect.poll(phase, { timeout: 15_000 }).toBe('recording')
    expect(await microphones()).toHaveLength(2)
    // Destination lookup no longer holds back the microphone.
    expect((await helperEvents(logPath)).filter(event => event.type === 'frontmost-end')).toHaveLength(0)
    await expect.poll(() => helperEvents(logPath).then(events => events.filter(event => event.type === 'frontmost-abort' && event.index === 1).length)).toBe(1)

    // Let the new destination resolve during the real JFK capture, then
    // stop exactly once with the third press of the locked gesture.
    await new Promise(resolve => setTimeout(resolve, 11_300))
    await expect.poll(() => helperEvents(logPath).then(events => events.filter(event => event.type === 'frontmost-end' && event.pid === 222).length), { timeout: 5_000 }).toBe(1)
    await edge('down'); await edge('up')
    await expect.poll(phase, { timeout: 30_000 }).toBe('ready')
    expect(await captureStops()).toHaveLength(1)
    const completed = await state()
    expect(completed.transcript?.text).toMatch(/country/i)
    // The mocked helper validates routing only; native clipboard restoration has its own integration check.
    expect(completed.delivery).toBe('sent')
    expect(completed.transcript?.deliveryMessage).toMatch(/Paste sent/i)
    expect((await helperEvents(logPath)).filter(event => event.type === 'paste').map(event => event.pid)).toEqual([222])

    // A later quick-tap cancellation must preserve the delivery message on the
    // completed transcript while its delayed snapshot is still pending.
    const deliveryMessage = completed.transcript?.deliveryMessage
    await edge('down'); await edge('up')
    await expect.poll(phase).toBe('starting')
    await expect.poll(phase).toBe('ready')
    const afterCancel = await state()
    expect(afterCancel.transcript?.deliveryMessage).toBe(deliveryMessage)
    expect(afterCancel.transcript?.text).toMatch(/country/i)
    expect((await helperEvents(logPath)).filter(event => event.type === 'paste')).toHaveLength(1)
  } finally {
    if ((await helperEvents(logPath)).some(event => event.type === 'frontmost-start' && event.index === 3)) {
      await expect.poll(() => helperEvents(logPath).then(events => events.filter(event => event.type === 'frontmost-abort' && event.index === 3).length), { timeout: 5_000 }).toBe(1)
    }
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
})
