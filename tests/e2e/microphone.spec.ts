import { isolatedElectron as electron } from './isolation'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultSettings } from '../../src/main/settings'

async function settingsSnapshot(app: ElectronApplication, page: Page, width: number, suffix = '') {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().endsWith('#hud'))!.setContentSize(width, 920), width)
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
  expect(await page.evaluate(() => [...document.querySelectorAll('button, select')].filter(element => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1 || rect.height < 43)
  }).map(element => element.textContent))).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: `artifacts/microphone${suffix}-${width}.png`, fullPage: true })
}

test('selected microphone, input test cleanup, first words, disconnection and clip choice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-microphone-'))
  const clips = join(directory, 'clips')
  await mkdir(clips)
  await mkdir('artifacts', { recursive: true })
  for (const name of ['01 Hello.mp3', '02 Talk to me.mp3', '03 Yes.mp3']) await writeFile(join(clips, name), 'test-only player fixture')
  const playerLog = join(directory, 'played.txt')
  await writeFile(playerLog, '')
  const player = join(directory, 'test-player.cjs')
  await writeFile(player, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(playerLog)}, process.argv[2] + '\\n')\n`, { mode: 0o700 })
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...defaultSettings(directory), muteOtherAudio: false, modelPath: resolve('artifacts/ggml-tiny.en.bin'), autoPaste: false, activationSoundDirectory: clips }))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, TERRY_E2E: '1', TERRY_USER_DATA: directory, TERRY_TEST_SOUND_PLAYER: player } })
  try {
    await expect.poll(() => app.windows().filter(page => page.url().includes('index.html') && !page.url().endsWith('#hud')).length).toBe(1)
    const page = app.windows().find(page => page.url().includes('index.html') && !page.url().endsWith('#hud'))!
    await page.evaluate(bytes => {
      const own = window as any
      own.__devices = [{ deviceId: 'yeti-fixture', label: 'Yeti Stereo Microphone' }, { deviceId: 'built-in-fixture', label: 'MacBook Pro Microphone' }]
      own.__constraints = []; own.__activeInputs = 0; own.__maxActiveInputs = 0; own.__latestTrack = null
      navigator.mediaDevices.enumerateDevices = async () => own.__devices.map((device: any) => ({ ...device, kind: 'audioinput', groupId: device.deviceId, toJSON: () => device }))
      navigator.mediaDevices.getUserMedia = async constraints => {
        own.__constraints.push(constraints)
        const exact = typeof constraints?.audio === 'object' ? (constraints.audio.deviceId as any)?.exact : ''
        const device = own.__devices.find((device: any) => device.deviceId === (exact || 'yeti-fixture'))
        if (!device) throw new DOMException('Selected microphone disconnected', 'OverconstrainedError')
        const context = new AudioContext()
        const source = context.createBufferSource()
        source.buffer = await context.decodeAudioData(Uint8Array.from(bytes).buffer)
        source.loop = true
        const destination = context.createMediaStreamDestination()
        source.connect(destination)
        await context.resume()
        const track = destination.stream.getAudioTracks()[0]
        Object.defineProperty(track, 'label', { value: device.label })
        track.getSettings = () => ({ deviceId: device.deviceId, sampleRate: context.sampleRate, channelCount: 1 })
        const stop = track.stop.bind(track)
        let stopped = false
        track.stop = () => { if (stopped) return; stopped = true; own.__activeInputs--; stop(); source.stop(); void context.close() }
        own.__activeInputs++; own.__maxActiveInputs = Math.max(own.__maxActiveInputs, own.__activeInputs); own.__latestTrack = track
        source.start()
        return destination.stream
      }
    }, Array.from(await readFile('artifacts/jfk.wav')))
    const state = () => page.evaluate(() => window.terry.getState())
    const phase = () => state().then(state => state.phase)
    const activeInputs = () => page.evaluate(() => (window as any).__activeInputs)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByLabel('Microphone', { exact: true }).selectOption('yeti-fixture')
    await page.getByRole('button', { name: 'Test input', exact: true }).click()
    await expect.poll(activeInputs).toBe(1)
    await expect.poll(() => page.getByRole('meter', { name: 'Test microphone level' }).getAttribute('aria-valuenow').then(Number)).toBeGreaterThan(0)
    await expect(page.locator('.actual-input')).toContainText('Yeti Stereo Microphone')
    await settingsSnapshot(app, page, 1440, '-testing')
    await settingsSnapshot(app, page, 390, '-testing')
    await page.getByRole('button', { name: 'Stop test', exact: true }).click()
    await expect.poll(activeInputs).toBe(0)

    await page.getByLabel('Activation sound', { exact: true }).selectOption('clips')
    await page.getByLabel('Voice clip', { exact: true }).selectOption('01 Hello.mp3')
    await page.getByRole('button', { name: /^Preview/ }).click()
    await expect.poll(async () => readFile(playerLog, 'utf8')).toBe(join(clips, '01 Hello.mp3') + '\n')
    await page.getByRole('button', { name: 'Save settings', exact: true }).click()
    await expect.poll(() => state().then(state => state.settings.activationSoundClip)).toBe('01 Hello.mp3')
    expect((await state()).settings.microphoneId).toBe('yeti-fixture')
    expect((await state()).settings.microphoneLabel).toBe('Yeti Stereo Microphone')
    expect(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).microphoneId).toBe('yeti-fixture')
    await settingsSnapshot(app, page, 1440)
    await settingsSnapshot(app, page, 390)

    // A shortcut must stop the live test before opening the recording input,
    // including while Settings is still mounted.
    await page.getByRole('button', { name: 'Test input', exact: true }).click()
    await expect.poll(activeInputs).toBe(1)
    await app.evaluate(() => {
      const edge = (globalThis as any).__terryHotkey
      edge({ type: 'down' }); edge({ type: 'up' }); edge({ type: 'down' }); edge({ type: 'up' })
    })
    await expect.poll(phase).toBe('recording')
    expect(await page.evaluate(() => (window as any).__maxActiveInputs)).toBe(1)
    await page.getByRole('button', { name: 'Dictation', exact: true }).click()
    expect((await state()).inputDevice?.label).toBe('Yeti Stereo Microphone')
    expect(await page.evaluate(() => (window as any).__constraints.at(-1).audio.deviceId)).toEqual({ exact: 'yeti-fixture' })
    await page.waitForTimeout(11_300)
    await page.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect.poll(phase, { timeout: 30_000 }).toBe('ready')
    await expect.poll(activeInputs).toBe(0)
    let transcript = (await state()).transcript!.text
    expect(transcript).toMatch(/and so my fellow americans/i)
    expect(transcript).toMatch(/for your country[.!]?$/i)

    // Loss during a session produces an explicit error and keeps the last text.
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await expect.poll(phase).toBe('recording')
    await page.waitForTimeout(3500)
    await page.evaluate(() => (window as any).__latestTrack.dispatchEvent(new Event('ended')))
    await expect.poll(phase).toBe('error')
    await expect.poll(activeInputs).toBe(0)
    expect((await state()).message).toMatch(/disconnected/i)
    expect((await state()).transcript?.text).toBe(transcript)
    expect((await state()).canRetry).toBe(true)
    await page.getByRole('button', { name: 'Retry audio', exact: true }).click()
    await expect.poll(phase, { timeout: 30_000 }).toBe('ready')
    transcript = (await state()).transcript!.text
    expect(transcript).toMatch(/fellow americans/i)

    // Missing selected hardware cannot silently switch to the other input.
    await page.evaluate(() => { (window as any).__devices = [{ deviceId: 'built-in-fixture', label: 'MacBook Pro Microphone' }]; navigator.mediaDevices.dispatchEvent(new Event('devicechange')) })
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await expect.poll(phase).toBe('error')
    expect((await state()).message).toMatch(/microphone|input/i)
    expect((await state()).transcript?.text).toBe(transcript)
    expect((await state()).canRetry).toBe(false)
    expect(await activeInputs()).toBe(0)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByLabel('Microphone', { exact: true }).locator('option:checked')).toContainText('unavailable')
    await settingsSnapshot(app, page, 390, '-missing')
    await page.getByLabel('Microphone', { exact: true }).selectOption('built-in-fixture')
    await page.getByRole('button', { name: 'Save settings', exact: true }).click()
    await expect.poll(() => state().then(state => state.settings.microphoneId)).toBe('built-in-fixture')
    await page.getByRole('button', { name: 'Test input', exact: true }).click()
    await expect.poll(activeInputs).toBe(1)
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'))
    await expect.poll(activeInputs).toBe(0)
    await page.getByRole('button', { name: 'Test input', exact: true }).click()
    await expect.poll(activeInputs).toBe(1)
    await page.getByRole('button', { name: 'Close to menu bar', exact: true }).click()
    await expect.poll(activeInputs).toBe(0)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
