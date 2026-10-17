import { isolatedElectron as electron } from './isolation'
import { test, expect, type Page, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { defaultSettings } from '../../src/main/settings'

async function snapshot(page: Page, app: ElectronApplication, width: number, name: string) {
  await app.evaluate(({ BrowserWindow }, width) => {
    const win = BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().endsWith('#hud'))!
    win.setContentSize(width, 920)
  }, width)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
  const geometry = await page.evaluate(() => ({
    width: window.innerWidth, scroll: document.documentElement.scrollWidth,
    clipped: Array.from(document.querySelectorAll('button')).filter(el => {
      const r = el.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1 || r.height < 43)
    }).map(el => el.textContent)
  }))
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.width)
  expect(geometry.clipped).toEqual([])
  await page.screenshot({ path: `artifacts/${name}-${width}.png`, fullPage: true })
}

async function tinyHudSnapshot(hud: Page, app: ElectronApplication, name: string) {
  const geometry = await hud.evaluate(() => {
    const pill = document.querySelector('.hud')!
    const visual = document.querySelector('.hud-visual')!
    const p = pill.getBoundingClientRect(), v = visual.getBoundingClientRect()
    return { width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollWidth,
      pill: { width: p.width, height: p.height },
      fits: v.left >= p.left && v.right <= p.right && v.top >= p.top && v.bottom <= p.bottom,
      transparent: getComputedStyle(document.documentElement).backgroundColor }
  })
  expect(geometry).toEqual({ width: 112, height: 36, scroll: 112, pill: { width: 104, height: 28 }, fits: true, transparent: 'rgba(0, 0, 0, 0)' })
  expect(await hud.getByRole('button').count()).toBe(0)
  const native = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('#hud'))!
    const bounds = win.getBounds(), area = screen.getDisplayMatching(bounds).workArea
    return { width: bounds.width, height: bounds.height, focused: win.isFocused(), focusable: win.isFocusable(),
      centred: Math.abs(bounds.x + bounds.width / 2 - area.x - area.width / 2) <= 1,
      bottomGap: area.y + area.height - bounds.y - bounds.height }
  })
  expect(native).toEqual({ width: 112, height: 36, focused: false, focusable: false, centred: true, bottomGap: 8 })
  await hud.screenshot({ path: `artifacts/${name}.png` })
}

test('real speech recording, import, copy, cancellation and compact layout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'terry-e2e-'))
  const settings = { ...defaultSettings(dir), muteOtherAudio: false, modelPath: resolve('artifacts/ggml-tiny.en.bin'), autoPaste: false }
  await writeFile(join(dir, 'settings.json'), JSON.stringify(settings))
  await mkdir('artifacts', { recursive: true })
  const app = await electron.launch({ args: ['.'], env: { ...process.env, TERRY_E2E: '1', TERRY_USER_DATA: dir } })
  const errors: string[] = []
  try {
    await expect.poll(() => app.windows().filter(page => page.url().includes('index.html') && !page.url().endsWith('#hud')).length).toBe(1)
    const page = app.windows().find(page => page.url().includes('index.html') && !page.url().endsWith('#hud'))!
    page.on('pageerror', error => errors.push(error.message))
    // Explicit test-only microphone: decode a real speech file into a MediaStream.
    // Electron 44's fake hardware delivered silence in an independent analyser control;
    // real Chrome delivered this same file. This tests capture/DSP/IPC/inference, not hardware.
    await page.evaluate((bytes) => {
      navigator.mediaDevices.getUserMedia = async () => {
        const sourceContext = new AudioContext()
        const audio = await sourceContext.decodeAudioData(Uint8Array.from(bytes).buffer)
        const source = sourceContext.createBufferSource()
        source.buffer = audio
        source.loop = true
        const destination = sourceContext.createMediaStreamDestination()
        source.connect(destination)
        await sourceContext.resume()
        source.start()
        const track = destination.stream.getAudioTracks()[0]
        const originalStop = track.stop.bind(track)
        track.stop = () => { originalStop(); source.stop(); void sourceContext.close() }
        return destination.stream
      }
    }, Array.from(await readFile('artifacts/jfk.wav')))

    await expect(page.getByRole('heading', { name: 'Talk to me.' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start dictation', exact: true })).toBeEnabled()
    await snapshot(page, app, 1440, 'ready')
    await snapshot(page, app, 390, 'ready')
    // Real historical speech artifact through the same production WAV pipeline.
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, resolve('artifacts/jfk.wav'))
    await page.getByRole('button', { name: /Import.*WAV/ }).first().click()
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.transcript?.text)), { timeout: 30_000 }).toContain('country')
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.phase))).toBe('ready')
    const imported = await page.evaluate(() => window.terry.getState().then(s => s.transcript!.text))
    await snapshot(page, app, 1440, 'transcript')
    await snapshot(page, app, 390, 'transcript')
    // Successful results reach the clipboard without an extra Copy action.
    expect(await app.evaluate(async ({ clipboard }) => await clipboard.readText())).toBe(imported)
    await page.getByRole('button', { name: /Copy transcript/i }).click()
    expect(await app.evaluate(async ({ clipboard }) => await clipboard.readText())).toBe(imported)
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.phase)), { timeout: 15_000 }).toBe('recording')
    await snapshot(page, app, 390, 'recording')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.phase))).toBe('ready')
    expect(await page.evaluate(() => window.terry.getState().then(s => s.transcript!.text))).toBe(imported)
    // Real native-event boundary with an explicit test driver; this does not claim
    // macOS key permission. The hidden renderer still captures real WAV audio.
    const edge = (type: string) => app.evaluate((_electron, type) => (globalThis as any).__terryHotkey({ type }), type)
    await edge('down')
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.phase))).toBe('recording')
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.recordingMode))).toBe('hold')
    await snapshot(page, app, 390, 'recording-hold')
    const hud = app.windows().find(p => p.url().endsWith('#hud'))!
    await expect(hud.getByRole('status')).toContainText('Listening while held')
    await tinyHudSnapshot(hud, app, 'hud-hold')
    await page.getByRole('button', { name: 'Close to menu bar', exact: true }).click()
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().endsWith('#hud'))!.isVisible())).toBe(false)
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.level)), { timeout: 4000 }).toBeGreaterThan(0.0005)
    await page.waitForTimeout(11_300)
    await edge('up')
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.phase)), { timeout: 30_000 }).toMatch(/^(ready|error)$/)
    const capturedState = await page.evaluate(() => window.terry.getState())
    expect(capturedState.phase, capturedState.message).toBe('ready')
    expect(capturedState.transcript!.text).toMatch(/country/i)
    expect(await app.evaluate(async ({ clipboard }) => await clipboard.readText())).toBe(capturedState.transcript!.text)
    const menuLabels = await app.evaluate(() => (globalThis as any).__terryMenu().items.map((item: any) => item.label))
    expect(menuLabels).toContain('Open Terry Tibbs')
    expect(menuLabels).toContain('Quit Terry Tibbs')
    await app.evaluate(() => (globalThis as any).__terryMenu().items.find((item: any) => item.label === 'Open Terry Tibbs').click())
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().endsWith('#hud'))!.isVisible())).toBe(true)
    await page.evaluate(async () => { const s = await window.terry.getState(); await window.terry.saveSettings({ ...s.settings, autoPaste: true }) })
    // Double-tap locks despite the second release; the next down stops once.
    await app.evaluate(() => { for (const type of ['down', 'up', 'down', 'up']) (globalThis as any).__terryHotkey({ type }) })
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.phase))).toBe('recording')
    expect(await page.evaluate(() => window.terry.getState().then(s => s.recordingMode))).toBe('locked')
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => window.terry.getState().then(s => s.phase))).toBe('recording')
    await snapshot(page, app, 390, 'recording-locked')
    await expect(hud.locator('.hud-lock')).toBeVisible()
    await tinyHudSnapshot(hud, app, 'hud-locked')
    await page.waitForTimeout(11_000)
    await edge('down'); await edge('up')
    await expect(hud.getByRole('status')).toContainText('Transcribing')
    await tinyHudSnapshot(hud, app, 'hud-transcribing')
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.phase)), { timeout: 30_000 }).toMatch(/^(ready|error)$/)
    const lockedState = await page.evaluate(() => window.terry.getState())
    expect(lockedState.phase, lockedState.message).toBe('ready')
    expect(lockedState.transcript!.text).toMatch(/country/i)
    expect(lockedState.delivery).toBe('clipboard')
    expect(lockedState.message).toContain('Copied only')
    await expect(hud.locator('.hud-result')).toHaveText('Copied')
    await tinyHudSnapshot(hud, app, 'hud-copied-only')
    const lockedResult = await page.evaluate(() => window.terry.getState().then(s => s.transcript!.text))
    expect(await app.evaluate(async ({ clipboard }) => await clipboard.readText())).toBe(lockedResult)
    // Release while getUserMedia is pending must cancel, with no late recording.
    await page.evaluate(() => {
      const media = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      ;(window as any).__media = media
      navigator.mediaDevices.getUserMedia = async constraints => { await new Promise(r => setTimeout(r, 1000)); return media(constraints) }
    })
    await edge('down')
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.phase))).toBe('starting')
    await page.waitForTimeout(250); await edge('up')
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.phase))).toBe('ready')
    await page.waitForTimeout(1200)
    expect(await page.evaluate(() => window.terry.getState().then(s => s.phase))).toBe('ready')
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = (window as any).__media })
    // A lost native monitor cancels an active recording, preserving the last result.
    await edge('down')
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.phase))).toBe('recording')
    await edge('unavailable')
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.phase))).toBe('ready')
    await edge('ready')
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.phase))).toBe('recording')
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'))
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.phase))).toBe('ready')
    // Known-good file succeeded above. Now verify real invalid input retains that result.
    const invalid = join(dir, 'invalid.wav')
    await writeFile(invalid, 'invalid WAV')
    await app.evaluate(({ dialog, BrowserWindow }, path) => {
      dialog.showOpenDialog = async () => {
        BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().endsWith('#hud'))!.hide()
        return { canceled: false, filePaths: [path] }
      }
    }, invalid)
    await page.getByRole('button', { name: /Import.*WAV/ }).first().click()
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.phase))).toBe('error')
    expect(await page.evaluate(() => window.terry.getState().then(s => s.transcript?.text))).toMatch(/country/i)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().endsWith('#hud'))!.isVisible())).toBe(false)
    await expect(hud.getByRole('status')).toContainText('Needs attention')
    await tinyHudSnapshot(hud, app, 'hud-error')
    await app.evaluate(() => (globalThis as any).__terryMenu().items.find((item: any) => item.label === 'Open Terry Tibbs').click())
    await snapshot(page, app, 1440, 'error')
    await snapshot(page, app, 390, 'error')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await snapshot(page, app, 1440, 'settings')
    await snapshot(page, app, 390, 'settings')
    await app.evaluate(() => (globalThis as any).__terryMenu().items.find((item: any) => item.label.startsWith('Shortcut:')).click())
    await expect(page.getByLabel('Global shortcut', { exact: true })).toBeInViewport()
    await page.getByRole('button', { name: 'Record shortcut', exact: true }).click()
    await expect(page.getByText('Press your shortcut now', { exact: true })).toBeVisible()
    await page.keyboard.press('Control+Shift+KeyD')
    await expect(page.getByRole('button', { name: 'Use shortcut', exact: true })).toBeVisible()
    await snapshot(page, app, 390, 'shortcut-confirm')
    await page.getByRole('button', { name: 'Use shortcut', exact: true }).click()
    await expect(page.getByLabel('Global shortcut', { exact: true })).toHaveValue('LeftControl+LeftShift+D')
    await page.getByLabel('Vocabulary', { exact: true }).fill('Alex, TypeScript')
    await page.getByRole('button', { name: 'Save settings', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.settings.shortcut))).toBe('LeftControl+LeftShift+D')
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).vocabulary).toBe('Alex, TypeScript')
    // Closing and reopening during shortcut capture discards the capture and resumes.
    await page.getByRole('button', { name: 'Record shortcut', exact: true }).click()
    await expect(page.getByText('Press your shortcut now', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Close to menu bar', exact: true }).click()
    await app.evaluate(() => (globalThis as any).__terryMenu().items.find((item: any) => item.label === 'Open Terry Tibbs').click())
    await expect(page.getByRole('button', { name: 'Record shortcut', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeEnabled()
    await expect(page.getByText('Press your shortcut now', { exact: true })).toHaveCount(0)
    await page.getByLabel('Global shortcut', { exact: true }).fill('A')
    await page.getByRole('button', { name: 'Save settings', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: /shortcut|function key|modifier/i })).toBeVisible()
    expect(await page.evaluate(() => window.terry.getState().then(s => s.settings.shortcut))).toBe('LeftControl+LeftShift+D')
    await page.getByLabel('Global shortcut', { exact: true }).fill('LeftControl+LeftShift+D')
    const badModel = join(dir, 'incomplete-model.bin')
    await writeFile(badModel, 'incomplete model')
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, badModel)
    await page.getByRole('button', { name: 'Choose', exact: true }).nth(1).click()
    await page.getByRole('button', { name: 'Save settings', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.modelReady))).toBe(false)
    await page.getByRole('button', { name: 'Dictation', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Set up dictation', exact: true })).toBeEnabled()
    await snapshot(page, app, 1440, 'missing-model')
    await snapshot(page, app, 390, 'missing-model')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, resolve('artifacts/ggml-tiny.en.bin'))
    await page.getByRole('button', { name: 'Choose', exact: true }).nth(1).click()
    await page.getByRole('button', { name: 'Save settings', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.modelReady))).toBe(true)

    // Exercise a reviewed cancellation race through the real UI and speech engine.
    // Only Ollama is held pending. The previous completed transcript must survive Cancel.
    await app.evaluate(() => {
      ;(globalThis as any).__originalFetch = globalThis.fetch
      globalThis.fetch = async (input, init) => {
        if (String(input).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'test-local', capabilities: ['completion'] }] }), { headers: { 'content-type': 'application/json' } })
        if (String(input).endsWith('/api/chat')) return await new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }) })
        const url = new URL(String(input))
        if (url.hostname === '127.0.0.1' && ['/health', '/inference'].includes(url.pathname)) return await (globalThis as any).__originalFetch(input, init)
        throw new Error('Unexpected network request in isolated test')
      }
    })
    await page.getByRole('button', { name: /Check permissions again/ }).click()
    await page.getByLabel('Clean up my transcript').check()
    await page.getByLabel('Ollama model', { exact: true }).selectOption('test-local')
    await page.getByRole('button', { name: 'Save settings', exact: true }).click()
    await page.getByRole('button', { name: 'Dictation', exact: true }).click()
    const previous = await page.evaluate(() => window.terry.getState().then(s => s.transcript))
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, resolve('artifacts/jfk.wav'))
    await page.getByRole('button', { name: /Import.*WAV/ }).first().click()
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.phase)), { timeout: 30_000 }).toBe('cleaning')
    await snapshot(page, app, 1440, 'cleaning')
    await snapshot(page, app, 390, 'cleaning')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.phase))).toBe('ready')
    expect(await page.evaluate(() => window.terry.getState().then(s => s.transcript))).toEqual(previous)
    await app.evaluate(() => { globalThis.fetch = (globalThis as any).__originalFetch })
    expect(errors).toEqual([])
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }) }
})

test('Globe/Fn can be selected without a browser key event, including while recording a key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'terry-globe-'))
  const settings = { ...defaultSettings(dir), muteOtherAudio: false, modelPath: resolve('artifacts/ggml-tiny.en.bin') }
  await writeFile(join(dir, 'settings.json'), JSON.stringify(settings))
  const launch = () => electron.launch({ args: ['.'], env: { ...process.env, TERRY_E2E: '1', TERRY_USER_DATA: dir } })
  let app = await launch()
  try {
    const getMain = async () => {
      await expect.poll(() => app.windows().filter(p => p.url().includes('index.html') && !p.url().endsWith('#hud')).length).toBe(1)
      return app.windows().find(p => p.url().includes('index.html') && !p.url().endsWith('#hud'))!
    }
    let page = await getMain()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    // Control: ordinary keyboard capture still accepts a known supported chord.
    await page.getByRole('button', { name: 'Record shortcut', exact: true }).click()
    await expect(page.getByText('Press your shortcut now', { exact: true })).toBeVisible()
    await page.keyboard.press('Control+Shift+KeyD')
    await page.getByRole('button', { name: 'Use shortcut', exact: true }).click()
    await expect(page.getByLabel('Global shortcut', { exact: true })).toHaveValue('LeftControl+LeftShift+D')
    await page.getByRole('button', { name: 'Save settings', exact: true }).click()
    // Actual fix path: Globe needs no DOM Fn key event. Exit an active picker safely.
    await page.getByRole('button', { name: 'Record shortcut', exact: true }).click()
    await expect(page.getByText('Press your shortcut now', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Use Globe / Fn', exact: true }).click()
    await expect(page.getByText('Press your shortcut now', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeEnabled()
    await expect(page.getByLabel('Global shortcut', { exact: true })).toHaveValue('Fn')
    await page.getByRole('button', { name: 'Save settings', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.settings.shortcut))).toBe('Fn')
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).shortcut).toBe('Fn')
    for (const width of [1440, 390]) {
      await snapshot(page, app, width, 'globe-settings')
      await page.locator('.shortcut-recorder').screenshot({ path: `artifacts/globe-picker-${width}.png` })
    }
    await app.close()
    app = await launch()
    page = await getMain()
    await expect(page.getByText('Globe / Fn', { exact: true })).toHaveCount(2)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByLabel('Global shortcut', { exact: true })).toHaveValue('Fn')
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }) }
})

test('activation clips finish before microphone capture, rotate and cancel safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'terry-cues-'))
  const clips = join(dir, 'voice clips')
  const events = join(dir, 'playback.jsonl')
  const player = join(dir, 'player.cjs')
  await mkdir(clips)
  await writeFile(join(clips, '01 short.mp3'), '700')
  await writeFile(join(clips, '02 longer.mp3'), '1200')
  await writeFile(events, '')
  // Test-only subprocess reports actual completion at different durations.
  // The production build always uses /usr/bin/afplay.
  await writeFile(player, `#!${process.execPath}\nconst fs = require('node:fs');
const clip = process.argv[2];
const log = type => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({ type, clip, at: Date.now() }) + '\\n');
log('start');
process.on('SIGTERM', () => { log('cancel'); process.exit(0); });
setTimeout(() => { log('end'); process.exit(0); }, Number(fs.readFileSync(clip, 'utf8')));
`)
  await chmod(player, 0o700)
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ ...defaultSettings(dir), muteOtherAudio: false, modelPath: resolve('artifacts/ggml-tiny.en.bin'), autoPaste: false }))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, TERRY_E2E: '1', TERRY_USER_DATA: dir, TERRY_TEST_SOUND_PLAYER: player } })
  const playback = async () => (await readFile(events, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; clip: string; at: number })
  try {
    await expect.poll(() => app.windows().filter(p => p.url().includes('index.html') && !p.url().endsWith('#hud')).length).toBe(1)
    const page = app.windows().find(p => p.url().includes('index.html') && !p.url().endsWith('#hud'))!
    await page.evaluate(bytes => {
      ;(window as any).__micStarts = []
      navigator.mediaDevices.getUserMedia = async () => {
        ;(window as any).__micStarts.push(Date.now())
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
    const microphones = () => page.evaluate(() => (window as any).__micStarts as number[])
    const phase = () => page.evaluate(() => window.terry.getState().then(s => s.phase))
    const edge = (type: string) => app.evaluate((_electron, type) => (globalThis as any).__terryHotkey({ type }), type)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByLabel('Activation sound', { exact: true }).selectOption('clips')
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, clips)
    await page.getByRole('button', { name: 'Choose folder…', exact: true }).click()
    await expect(page.getByLabel('Voice clips folder', { exact: true })).toHaveValue(clips)
    await page.getByRole('button', { name: 'Save settings', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.settings.activationSound))).toBe('clips')
    await page.getByRole('button', { name: 'Preview next clip', exact: true }).click()
    await expect(page.getByText('Preview finished. Recording has not started.', { exact: true })).toBeVisible()
    expect(await microphones()).toEqual([])
    await snapshot(page, app, 1440, 'activation-settings')
    await snapshot(page, app, 390, 'activation-settings')
    await page.getByRole('button', { name: 'Dictation', exact: true }).click()
    // Known-good controls: preview did not advance rotation; both lengths must
    // finish and settle before even calling getUserMedia, not just before a label.
    for (const [index, name] of ['01 short.mp3', '02 longer.mp3'].entries()) {
      await page.getByRole('button', { name: 'Start dictation', exact: true }).click()
      await expect.poll(async () => (await playback()).filter(e => e.type === 'start').length).toBe(index + 2)
      expect((await microphones()).length).toBe(index)
      await expect.poll(phase).toBe('recording')
      await tinyHudSnapshot(app.windows().find(p => p.url().endsWith('#hud'))!, app, `hud-voice-${index}`)
      const finished = (await playback()).filter(e => e.type === 'end').at(-1)!
      expect(finished.clip).toBe(join(clips, name))
      expect((await microphones())[index] - finished.at).toBeGreaterThanOrEqual(140)
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect.poll(phase).toBe('ready')
    }
    // Releasing a held shortcut during playback stops the player. No late mic.
    await edge('down')
    await expect.poll(async () => (await playback()).filter(e => e.type === 'start').length).toBe(4)
    await page.waitForTimeout(240)
    await edge('up')
    await expect.poll(phase).toBe('ready')
    await expect.poll(async () => (await playback()).filter(e => e.type === 'cancel').length).toBe(1)
    await page.waitForTimeout(1000)
    expect(await phase()).toBe('ready')
    expect((await microphones()).length).toBe(2)
    // A double-tap during a longer cue locks the eventual recording.
    await app.evaluate(() => { for (const type of ['down', 'up', 'down', 'up']) (globalThis as any).__terryHotkey({ type }) })
    await expect.poll(phase).toBe('starting')
    await expect(app.windows().find(p => p.url().endsWith('#hud'))!.locator('.hud-lock')).toBeVisible()
    await expect(app.windows().find(p => p.url().endsWith('#hud'))!.getByRole('status')).toContainText('Locked, getting ready')
    expect((await microphones()).length).toBe(2)
    await tinyHudSnapshot(app.windows().find(p => p.url().endsWith('#hud'))!, app, 'hud-activation')
    await expect.poll(phase).toBe('recording')
    expect(await page.evaluate(() => window.terry.getState().then(s => s.recordingMode))).toBe('locked')
    const finished = (await playback()).filter(e => e.type === 'end').at(-1)!
    expect(finished.clip).toBe(join(clips, '02 longer.mp3'))
    expect((await microphones())[2] - finished.at).toBeGreaterThanOrEqual(140)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(phase).toBe('ready')
    // Unsaved preview with saved activation Off must also settle before capture.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByLabel('Activation sound', { exact: true }).selectOption('off')
    await page.getByRole('button', { name: 'Save settings', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.settings.activationSound))).toBe('off')
    await page.getByLabel('Activation sound', { exact: true }).selectOption('clips')
    await page.getByRole('button', { name: 'Preview next clip', exact: true }).click()
    await expect.poll(async () => (await playback()).filter(e => e.type === 'start').length).toBe(6)
    await edge('down')
    await expect.poll(phase).toBe('recording')
    const stopped = (await playback()).filter(e => e.type === 'cancel').at(-1)!
    expect((await microphones())[3] - stopped.at).toBeGreaterThanOrEqual(140)
    await page.evaluate(() => window.terry.cancel())
    await expect.poll(phase).toBe('ready')
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }) }
})


test('native function key candidates reach the picker and save without browser key events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'terry-native-picker-'))
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ ...defaultSettings(dir), muteOtherAudio: false }))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, TERRY_E2E: '1', TERRY_USER_DATA: dir } })
  try {
    await expect.poll(() => app.windows().filter(p => p.url().includes('index.html') && !p.url().endsWith('#hud')).length).toBe(1)
    const page = app.windows().find(p => p.url().includes('index.html') && !p.url().endsWith('#hud'))!
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().endsWith('#hud'))!; win.show(); win.focus() })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    for (const key of ['F13', 'F14', 'F15', 'Fn']) {
      await page.getByRole('button', { name: 'Record shortcut', exact: true }).click()
      await expect(page.getByText('Press your shortcut now', { exact: true })).toBeVisible()
      // IPC boundary test. Native CGEvent handling is exercised separately.
      await app.evaluate(({ BrowserWindow }, key) => { BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().endsWith('#hud'))!.webContents.send('terry:shortcut-candidate', key) }, key)
      await page.getByRole('button', { name: 'Use shortcut', exact: true }).click()
      await expect(page.getByLabel('Global shortcut', { exact: true })).toHaveValue(key)
      await page.getByRole('button', { name: 'Save settings', exact: true }).click()
      await expect.poll(() => page.evaluate(() => window.terry.getState().then(s => s.settings.shortcut))).toBe(key)
    }
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().endsWith('#hud'))!.webContents.send('terry:shortcut-candidate', 'F13') })
    await expect(page.getByLabel('Global shortcut', { exact: true })).toHaveValue('Fn')
    await page.getByRole('button', { name: 'Record shortcut', exact: true }).click()
    await expect(page.getByText('Press your shortcut now', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Record shortcut', exact: true })).toBeEnabled()
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).shortcut).toBe('Fn')
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }) }
})
