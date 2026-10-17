import { isolatedElectron as electron } from './isolation'
import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultSettings } from '../../src/main/settings'

test('input selection, automatic recovery and confirmed local learning survive the real recognition path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-recovery-learning-'))
  await mkdir('artifacts', { recursive: true })
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...defaultSettings(directory), modelPath: resolve('artifacts/ggml-tiny.en.bin'), muteOtherAudio: false, autoPaste: false }))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, TERRY_E2E: '1', TERRY_USER_DATA: directory } })
  try {
    // Recognition/UI evidence only. No test transcript enters the user's clipboard.
    await app.evaluate(({ clipboard, systemPreferences }) => {
      clipboard.writeText = async () => undefined
      // This harness supplies a software microphone, so permission status must
      // not depend on whether this worktree's Electron binary has TCC consent.
      systemPreferences.getMediaAccessStatus = () => 'granted'
    })
    await expect.poll(() => app.windows().filter(page => page.url().includes('index.html') && !page.url().endsWith('#hud')).length).toBe(1)
    const page = app.windows().find(page => page.url().includes('index.html') && !page.url().endsWith('#hud'))!
    await page.evaluate(bytes => {
      const own = window as any
      own.__devices = [{ deviceId: 'desk', label: 'Desk USB Microphone' }, { deviceId: 'built-in', label: 'Built-in Microphone' }]
      own.__requests = []; own.__tracks = 0; own.__maxTracks = 0; own.__graphs = []
      navigator.mediaDevices.enumerateDevices = async () => own.__devices.map((device: any) => ({ ...device, kind: 'audioinput', groupId: device.deviceId, toJSON: () => device }))
      navigator.mediaDevices.getUserMedia = async constraints => {
        const id = typeof constraints?.audio === 'object' ? (constraints.audio.deviceId as any)?.exact : 'desk'
        own.__requests.push(id)
        const device = own.__devices.find((item: any) => item.deviceId === (id || 'desk'))
        if (!device) throw new DOMException('Disconnected', 'OverconstrainedError')
        const producer = new AudioContext(), output = producer.createMediaStreamDestination()
        const audio = await producer.decodeAudioData(Uint8Array.from(bytes).buffer)
        await producer.resume()
        const track = output.stream.getAudioTracks()[0], stop = track.stop.bind(track)
        Object.defineProperty(track, 'label', { value: device.label })
        track.getSettings = () => ({ deviceId: device.deviceId, sampleRate: producer.sampleRate })
        const graph = { track, producer, output, audio, sources: [] as AudioBufferSourceNode[] }
        let stopped = false
        track.stop = () => { if (stopped) return; stopped = true; own.__tracks--; stop(); graph.sources.forEach(source => source.stop()); void producer.close() }
        own.__graphs.push(graph); own.__tracks++; own.__maxTracks = Math.max(own.__tracks, own.__maxTracks)
        return output.stream
      }
      own.__speak = () => {
        const graph = own.__graphs.at(-1), source = graph.producer.createBufferSource()
        source.buffer = graph.audio; source.connect(graph.output); graph.sources.push(source); source.start()
      }
    }, Array.from(await readFile('artifacts/jfk.wav')))
    const state = () => page.evaluate(() => window.terry.getState())
    const requests = () => page.evaluate(() => (window as any).__requests.length)
    const ready = () => state().then(state => state.microphoneReady)
    await page.evaluate(() => window.terry.refresh())
    await page.getByRole('button', { name: 'Change microphone', exact: true }).click()
    await expect(page.getByLabel('Microphone', { exact: true })).toBeFocused()
    await page.getByLabel('Vocabulary', { exact: true }).fill('An unsaved vocabulary draft')
    await page.getByLabel('Microphone', { exact: true }).selectOption('desk')
    await expect.poll(() => state().then(state => state.settings.microphoneId)).toBe('desk')
    await expect(page.getByLabel('Vocabulary', { exact: true })).toHaveValue('An unsaved vocabulary draft')
    await page.getByLabel('Vocabulary', { exact: true }).fill('')
    await page.getByRole('checkbox', { name: /Keep microphone ready/ }).check()
    await page.getByRole('button', { name: 'Save settings', exact: true }).click()
    await expect.poll(async () => {
      const current = await state()
      return { ready: current.microphoneReady, permission: current.microphone, enabled: current.settings.keepMicrophoneReady, message: current.microphonePreparation, requests: await requests() }
    }).toMatchObject({ ready: true, permission: 'granted', enabled: true })
    expect(await requests()).toBe(1)
    await expect(page.locator('.actual-input')).toContainText('Using: Desk USB Microphone')
    await page.getByRole('button', { name: 'Test input', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stop test', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Stop test', exact: true }).click()
    await expect.poll(ready).toBe(true)
    await expect(page.locator('.actual-input')).toContainText('ready for dictation')
    const beforeRecovery = await requests()
    // Known-good readiness above, followed by an actual track-ended event through
    // the controller and real AudioWorklet frames from a replacement stream.
    await page.evaluate(() => (window as any).__graphs.at(-1).track.dispatchEvent(new Event('ended')))
    await expect.poll(requests).toBe(beforeRecovery + 1)
    await expect.poll(ready).toBe(true)
    expect(await page.evaluate(() => (window as any).__maxTracks)).toBe(1)
    await page.evaluate(() => {
      const own = window as any
      own.__devices = own.__devices.filter((device: any) => device.deviceId !== 'desk')
      own.__graphs.at(-1).track.dispatchEvent(new Event('ended'))
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'))
    })
    await expect.poll(ready).toBe(false)
    await expect(page.getByLabel('Microphone', { exact: true }).locator('option:checked')).toContainText('unavailable')
    await expect(page.getByRole('button', { name: 'Retry microphone', exact: true })).toBeVisible()
    await expect(page.locator('.actual-input .field-error')).toBeVisible()
    await page.waitForTimeout(5_000)
    const bounded = await requests()
    await page.waitForTimeout(1_000)
    expect(await requests()).toBe(bounded)
    expect(await page.evaluate(() => (window as any).__requests.every((id: string) => id === 'desk'))).toBe(true)
    await page.evaluate(() => {
      ;(window as any).__devices.push({ deviceId: 'desk', label: 'Desk USB Microphone' })
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'))
    })
    await expect.poll(ready).toBe(true)
    await page.getByLabel('Microphone', { exact: true }).selectOption('built-in')
    await expect.poll(() => state().then(state => state.inputDevice?.label)).toBe('Built-in Microphone')
    await page.getByLabel('Microphone', { exact: true }).selectOption('desk')
    await expect.poll(() => state().then(state => state.inputDevice?.label)).toBe('Desk USB Microphone')

    for (const width of [1440, 390]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().endsWith('#hud'))!.setContentSize(width, 920), width)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      expect(await page.evaluate(() => [...document.querySelectorAll('button, select')].filter(element => {
        const box = element.getBoundingClientRect()
        return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1 || box.height < 43)
      }).map(element => element.textContent))).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: `artifacts/recovery-settings-${width}.png`, fullPage: true })
    }
    await page.getByRole('button', { name: 'Dictation', exact: true }).click()
    const dictate = async (locked = false) => {
      await app.evaluate(async ({ BrowserWindow }, locked) => {
        await BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().endsWith('#hud'))!.webContents.executeJavaScript('window.__speak()')
        const edge = (globalThis as any).__terryHotkey
        edge({ type: 'down' })
        if (locked) { edge({ type: 'up' }); edge({ type: 'down' }); edge({ type: 'up' }) }
      }, locked)
      await expect.poll(() => state().then(state => state.phase)).toBe('recording')
      if (locked) expect((await state()).recordingMode).toBe('locked')
      await page.waitForTimeout(11_700)
      await app.evaluate((_electron, locked) => { const edge = (globalThis as any).__terryHotkey; edge({ type: locked ? 'down' : 'up' }); if (locked) edge({ type: 'up' }) }, locked)
      await expect.poll(() => state().then(state => state.phase), { timeout: 30_000 }).toBe('ready')
      expect((await state()).transcript?.text).toMatch(/^\s*and so[,\s]+my fellow Americans/i)
    }
    await dictate()
    const original = (await state()).transcript!
    await page.getByRole('button', { name: 'Correct words', exact: true }).click()
    await page.getByLabel('Corrected transcript', { exact: true }).fill(original.text.replace(/country/gi, 'Country'))
    await page.getByRole('button', { name: 'Review word changes', exact: true }).click()
    await expect(page.locator('.correction-choice')).toHaveCount(1)
    await page.screenshot({ path: 'artifacts/correction-review-390.png', fullPage: true })
    await page.getByRole('button', { name: 'Remember selected corrections', exact: true }).click()
    await expect.poll(() => state().then(state => state.settings.corrections)).toEqual([{ from: 'country', to: 'Country' }])
    expect(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).corrections).toEqual([{ from: 'country', to: 'Country' }])
    expect((await state()).transcript!.raw).toBe(original.raw)
    await dictate(true)
    expect((await state()).transcript!.text).toContain('Country')
    expect((await state()).transcript!.raw).toMatch(/country/)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('checkbox', { name: /Apply saved corrections/ }).uncheck()
    await page.getByRole('button', { name: 'Save settings', exact: true }).click()
    await page.evaluate(() => window.terry.retry())
    await expect.poll(() => state().then(state => state.phase), { timeout: 30_000 }).toBe('ready')
    expect((await state()).transcript!.text).toBe((await state()).transcript!.raw)
    await page.getByRole('button', { name: 'Remove correction for country', exact: true }).click()
    await page.getByRole('button', { name: 'Save settings', exact: true }).click()
    expect((await state()).settings.corrections).toEqual([])
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
