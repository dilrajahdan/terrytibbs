import { isolatedElectron as electron } from './isolation'
import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultSettings } from '../../src/main/settings'

test('warm audio service gates voice clips, keeps capture quiet and restores after every exit path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-background-e2e-'))
  const log = join(directory, 'events.jsonl'), control = join(directory, 'control'), helper = join(directory, 'audio-helper.cjs')
  const clips = join(directory, 'clips'); await mkdir(clips); await mkdir('artifacts', { recursive: true })
  await writeFile(join(clips, 'Hello.wav'), await readFile('/System/Library/Sounds/Tink.aiff'))
  await writeFile(log, ''); await writeFile(control, 'ok')
  await writeFile(helper, `#!${process.execPath}
const fs = require('node:fs'), readline = require('node:readline')
const log = event => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({event,pid:process.pid,at:Date.now()})+'\\n')
const mode = () => fs.readFileSync(${JSON.stringify(control)},'utf8')
const emit = data => console.log(JSON.stringify(data))
log('spawn')
let active = false, cue = null, cueTimer = null
process.on('exit', () => { if(active) log('restored'); log('closed') })
process.on('SIGTERM', () => process.exit(0))
setTimeout(() => { log('prepared'); emit({type:'standby'}) }, 200)
readline.createInterface({input:process.stdin}).on('line', line => {
 const c=JSON.parse(line)
 if(c.action==='stop') process.exit(0)
 if(c.action==='activate') setTimeout(() => {
  if(mode()==='fail') { emit({type:'error',message:'Background audio test could not mute.'}); process.exit(1) }
  active = true; log(c.mute ? 'muted' : 'cue-only'); emit({type:'ready',muted:c.mute})
 }, 200)
 if(c.action==='release') {
  clearTimeout(cueTimer)
  if(cue) emit({type:'cue-complete',id:cue,ok:false})
  cue=null; active=false; log('restored'); emit({type:'standby'})
 }
 if(c.action==='play') { cue=c.id; log('cue-start'); if(mode()==='hold-cue') return; cueTimer=setTimeout(() => { cue=null; log('cue-end'); emit({type:'cue-complete',id:c.id,ok:true}) }, 450) }
}).on('close', () => process.exit(0))
setInterval(() => { if(mode()==='crash') process.exit(1) }, 50)
`, { mode: 0o700 })
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...defaultSettings(directory), modelPath: resolve('artifacts/ggml-tiny.en.bin'), autoPaste: false, activationSound: 'clips', activationSoundDirectory: clips, activationSoundClip: 'Hello.wav' }))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, TERRY_E2E: '1', TERRY_USER_DATA: directory, TERRY_E2E_AUDIO_HELPER: helper } })
  let closed = false
  const events = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  try {
    await expect.poll(() => app.windows().filter(p => p.url().includes('index.html') && !p.url().endsWith('#hud')).length).toBe(1)
    const page = app.windows().find(p => p.url().includes('index.html') && !p.url().endsWith('#hud'))!
    await expect.poll(() => app.windows().filter(p => p.url().endsWith('#hud')).length).toBe(1)
    const hud = app.windows().find(p => p.url().endsWith('#hud'))!
    const state = () => page.evaluate(() => window.terry.getState())
    const phase = () => state().then(s => s.phase)
    const edge = (type: string) => app.evaluate((_e, type) => (globalThis as any).__terryHotkey({ type }), type)
    const micEvents = () => page.evaluate(() => (window as any).__micEvents as {event:string;at:number}[])
    await page.evaluate(bytes => {
      ;(window as any).__micEvents = []
      navigator.mediaDevices.getUserMedia = async () => {
        ;(window as any).__micEvents.push({event:'start',at:Date.now()})
        if ((window as any).__micFail) throw new Error('Selected microphone disconnected.')
        const context = new AudioContext(), source = context.createBufferSource(), destination = context.createMediaStreamDestination()
        source.buffer = await context.decodeAudioData(Uint8Array.from(bytes).buffer); source.loop = true
        source.connect(destination); await context.resume(); source.start()
        const track = destination.stream.getAudioTracks()[0], stop = track.stop.bind(track)
        track.stop = () => { (window as any).__micEvents.push({event:'stop',at:Date.now()}); stop(); source.stop(); void context.close() }
        return destination.stream
      }
    }, Array.from(await readFile('artifacts/jfk.wav')))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const mute = page.getByRole('checkbox', { name: /Mute other audio while dictating/ })
    await expect(mute).toBeChecked()
    await expect.poll(() => events().then(e => e.at(-1)?.event)).toBe('prepared')
    await mute.uncheck(); await page.getByRole('button', {name:'Save settings',exact:true}).click()
    await expect.poll(() => state().then(s => s.settings.muteOtherAudio)).toBe(false)
    await expect.poll(() => events().then(e => e.at(-1)?.event)).toBe('closed')
    await mute.check(); await page.getByRole('button', {name:'Save settings',exact:true}).click()
    await expect.poll(() => state().then(s => s.settings.muteOtherAudio)).toBe(true)
    await expect.poll(() => events().then(e => e.at(-1)?.event)).toBe('prepared')
    expect(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).muteOtherAudio).toBe(true)
    for (const width of [1440,390]) {
      await app.evaluate(({BrowserWindow},width) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().endsWith('#hud'))!.setContentSize(width,920),width)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      const geometry = await mute.evaluate(el => { const r=el.closest('label')!.getBoundingClientRect();return {height:r.height,left:r.left,right:r.right,width:innerWidth,scroll:document.documentElement.scrollWidth} })
      expect(geometry.height).toBeGreaterThanOrEqual(44);expect(geometry.left).toBeGreaterThanOrEqual(0);expect(geometry.right).toBeLessThanOrEqual(width);expect(geometry.scroll).toBeLessThanOrEqual(width)
      await page.screenshot({ path:`artifacts/background-audio-${width}.png`,fullPage:true })
    }
    await page.getByRole('button', {name:'Dictation',exact:true}).click()
    let before = (await events()).length
    const warmedPID = (await events()).at(-1)!.pid
    await app.evaluate(() => { for (const type of ['down','up','down','up']) (globalThis as any).__terryHotkey({type}) })
    await expect(hud.locator('.hud-lock')).toBeVisible()
    expect(await phase()).toBe('starting')
    expect(await micEvents()).toHaveLength(0)
    await expect.poll(phase).toBe('recording')
    const first = (await events()).slice(before), micStart = (await micEvents())[0].at
    expect(first.map(e => e.event)).toEqual(['muted','cue-start','cue-end'])
    expect(first.every(event => event.pid === warmedPID)).toBe(true)
    expect(micStart - first.at(-1)!.at).toBeGreaterThanOrEqual(140)
    await new Promise(resolve => setTimeout(resolve, 3_100))
    await edge('down'); await edge('up')
    await expect.poll(() => events().then(e => e.at(-1)?.event)).toBe('restored')
    expect((await events()).at(-1)!.at).toBeGreaterThanOrEqual((await micEvents()).at(-1)!.at)
    await expect.poll(phase, {timeout:30_000}).toBe('ready')
    expect((await state()).transcript?.text).toMatch(/fellow Americans/i)

    // Cancel the cue, then immediately start another locked session. The warm
    // process must restore the prior lease before activating the next lease.
    before = (await events()).length
    await writeFile(control, 'hold-cue')
    await edge('down')
    await expect.poll(() => events().then(e => e.at(-1)?.event)).toBe('cue-start')
    await page.evaluate(() => window.terry.cancel())
    await writeFile(control, 'ok')
    await app.evaluate(() => { for (const type of ['up','down','up','down','up']) (globalThis as any).__terryHotkey({type}) })
    await expect.poll(phase).toBe('recording')
    const restarted = (await events()).slice(before).map(e => e.event)
    expect(restarted).toEqual(['muted','cue-start','restored','muted','cue-start','cue-end'])
    expect((await events()).slice(before).every(event => event.pid === warmedPID)).toBe(true)
    await app.evaluate(({powerMonitor}) => powerMonitor.emit('lock-screen'))
    await expect.poll(phase).toBe('ready')
    await expect.poll(() => events().then(e => e.at(-1)?.event)).toBe('restored')
    await app.evaluate(({powerMonitor}) => powerMonitor.emit('unlock-screen'))

    const count = (await micEvents()).length
    await writeFile(control,'fail'); await page.getByRole('button',{name:'Start dictation',exact:true}).click()
    await expect.poll(phase).toBe('error')
    await expect.poll(() => events().then(e => e.at(-1)?.event)).toBe('closed')
    expect(await micEvents()).toHaveLength(count)
    await page.screenshot({path:'artifacts/background-audio-error-390.png',fullPage:true})
    await writeFile(control,'ok'); await page.evaluate(() => { (window as any).__micFail=true })
    await page.getByRole('button',{name:'Start dictation',exact:true}).click()
    await expect.poll(phase).toBe('error')
    await expect.poll(() => events().then(e => e.at(-1)?.event)).toBe('restored')
    await page.evaluate(() => { (window as any).__micFail=false })
    await page.getByRole('button',{name:'Start dictation',exact:true}).click()
    await expect.poll(phase).toBe('recording')
    await writeFile(control,'crash')
    await expect.poll(phase).toBe('error')
    await expect.poll(() => micEvents().then(e => e.at(-1)?.event)).toBe('stop')
    await expect.poll(() => events().then(e => e.at(-1)?.event)).toBe('closed')
    await writeFile(control,'ok')

    // Disabling both muting and cues needs no helper. Quit closes an active lease
    // and then terminates the standby process.
    await page.evaluate(async () => { const s=await window.terry.getState();await window.terry.saveSettings({...s.settings,muteOtherAudio:false,activationSound:'off'}) })
    before=(await events()).length
    await page.getByRole('button',{name:'Start dictation',exact:true}).click()
    await expect.poll(phase).toBe('recording');expect(await events()).toHaveLength(before)
    await page.evaluate(() => window.terry.cancel())
    await page.evaluate(async () => { const s=await window.terry.getState();await window.terry.saveSettings({...s.settings,muteOtherAudio:true}) })
    await page.getByRole('button',{name:'Start dictation',exact:true}).click()
    await expect.poll(phase).toBe('recording')
    await expect.poll(() => events().then(e => e.at(-1)?.event)).toBe('muted')
    await app.close();closed=true
    await expect.poll(() => events().then(e => e.at(-1)?.event)).toBe('closed')
    expect((await events()).slice(-2).map(event => event.event)).toEqual(['restored','closed'])
  } finally { if(!closed) await app.close(); await rm(directory,{recursive:true,force:true}) }
})

test('late mute activation failure preserves speech already completed by an early stop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-late-mute-e2e-'))
  const log = join(directory, 'events.jsonl'), control = join(directory, 'control'), helper = join(directory, 'audio-helper.cjs')
  await writeFile(log, ''); await writeFile(control, 'ok')
  await writeFile(helper, `#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline')
const emit=value=>console.log(JSON.stringify(value))
const log=event=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({event,at:Date.now()})+'\\n')
const mode=()=>fs.readFileSync(${JSON.stringify(control)},'utf8')
log('prepared');emit({type:'standby'})
process.on('exit',()=>log('closed'))
readline.createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line)
 if(c.action==='activate'){
  if(mode()==='ok'){log('muted');emit({type:'ready'});return}
  log('activate-pending')
  const timer=setInterval(()=>{if(mode()==='fail-now'){clearInterval(timer);log('activation-failed');emit({type:'error',message:'Delayed activation failure after capture finished.'});process.exit(1)}},5)
 }
 if(c.action==='release'){log('restored');emit({type:'standby'})}
 if(c.action==='stop')process.exit(0)
}).on('close',()=>process.exit(0))
`, { mode: 0o700 })
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...defaultSettings(directory), modelPath: resolve('artifacts/ggml-tiny.en.bin'), autoPaste: false, activationSound: 'off', keepMicrophoneReady: false }))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, TERRY_E2E: '1', TERRY_USER_DATA: directory, TERRY_E2E_AUDIO_HELPER: helper } })
  const events = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  try {
    await expect.poll(() => app.windows().filter(page => page.url().includes('index.html') && !page.url().endsWith('#hud')).length).toBe(1)
    const page = app.windows().find(page => page.url().includes('index.html') && !page.url().endsWith('#hud'))!
    const state = () => page.evaluate(() => window.terry.getState())
    await page.evaluate(async bytes => {
      // Inject only the capture-complete boundary so a complete, known-good
      // speech sample can race a sub-second mute transition deterministically.
      // No physical microphone is requested by this focused integration test.
      navigator.mediaDevices.getUserMedia = () => new Promise<MediaStream>(() => undefined)
      const decoder = new AudioContext({ sampleRate: 16_000 })
      const decoded = await decoder.decodeAudioData(Uint8Array.from(bytes).buffer)
      ;(window as any).__completeSpeech = decoded.getChannelData(0).slice()
      await decoder.close()
      ;(window as any).__lateMutePhases = []
      window.terry.onState(next => { (window as any).__lateMutePhases.push(next.phase) })
      window.terry.onCapture(command => {
        if (command.action !== 'start') return
        ;(window as any).__completeSession = command.sessionId
        window.terry.captureStarted(command.sessionId, { deviceId: 'captured-jfk-fixture', label: 'Completed JFK sample', sampleRate: 16_000 })
      })
    }, Array.from(await readFile('artifacts/jfk.wav')))
    const finishCapture = () => page.evaluate(async () => {
      await window.terry.toggle()
      window.terry.captureComplete((window as any).__completeSession, (window as any).__completeSpeech)
      return (await window.terry.getState()).phase
    })

    // Known-good control through the same complete boundary and real Whisper.
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await expect.poll(() => state().then(value => value.phase)).toBe('recording')
    await expect.poll(() => events().then(rows => rows.at(-1)?.event)).toBe('muted')
    expect(['transcribing', 'ready']).toContain(await finishCapture())
    await expect.poll(() => state().then(value => value.phase), { timeout: 30_000 }).toBe('ready')
    const controlTranscript = (await state()).transcript
    expect(controlTranscript?.text).toMatch(/and so.*fellow Americans/i)
    expect(controlTranscript?.text).toMatch(/for your country/i)
    await expect.poll(() => events().then(rows => rows.at(-1)?.event)).toBe('restored')

    await page.evaluate(async () => { await window.terry.clearTranscript(); (window as any).__lateMutePhases = [] })
    await writeFile(control, 'hold')
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await expect.poll(() => state().then(value => value.phase), { intervals: [10, 20, 30] }).toBe('recording')
    await expect.poll(() => events().then(rows => rows.at(-1)?.event), { intervals: [10, 20, 30] }).toBe('activate-pending')
    expect(['transcribing', 'ready']).toContain(await finishCapture())
    await writeFile(control, 'fail-now')
    await expect.poll(() => events().then(rows => rows.at(-1)?.event)).toBe('closed')
    expect((await events()).some(row => row.event === 'activation-failed')).toBe(true)
    await expect.poll(() => state().then(value => value.phase), { timeout: 30_000 }).toBe('ready')
    const recovered = (await state()).transcript
    expect(recovered).not.toBeNull()
    expect(recovered!.text).toBe(controlTranscript!.text)
    expect(await page.evaluate(() => (window as any).__lateMutePhases)).not.toContain('error')
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
