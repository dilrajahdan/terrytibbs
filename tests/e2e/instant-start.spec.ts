import { isolatedElectron as electron } from './isolation'
import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultSettings } from '../../src/main/settings'

test('speech beginning at trigger survives slow mute and an overlapping generated buzz, with an explicitly armed mic', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-instant-e2e-'))
  const log = join(directory,'events.jsonl'), helper = join(directory,'audio.cjs')
  await mkdir('artifacts',{recursive:true}); await writeFile(log,'')
  await writeFile(helper, `#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline');let active=false
const emit=x=>console.log(JSON.stringify(x)), log=event=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({event,at:Date.now()})+'\\n')
log('spawn');emit({type:'standby'})
readline.createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line)
 if(c.action==='activate'){log('activate');if(c.cue==='buzz'){log('cue-start');setTimeout(()=>{log('cue-end');emit({type:'cue-complete',id:c.id,ok:true})},500)}setTimeout(()=>{active=true;log('muted');emit({type:'ready'})},1100)}
 if(c.action==='play'){log('cue-start');setTimeout(()=>{log('cue-end');emit({type:'cue-complete',id:c.id,ok:true})},500)}
 if(c.action==='release'){active=false;log('restored');emit({type:'standby'})}
 if(c.action==='stop')process.exit(0)
}).on('close',()=>process.exit(0))
`,{mode:0o700})
  await writeFile(join(directory,'settings.json'),JSON.stringify({...defaultSettings(directory),modelPath:resolve('artifacts/ggml-tiny.en.bin'),autoPaste:false,activationSound:'buzz',keepMicrophoneReady:false}))
  const app=await electron.launch({args:['.'],env:{...process.env,TERRY_E2E:'1',TERRY_USER_DATA:directory,TERRY_E2E_AUDIO_HELPER:helper}})
  try {
    // This test verifies capture and recognition, not delivery. Keep the user's
    // clipboard untouched; native paste has its own preservation harness.
    await app.evaluate(({clipboard})=>{ clipboard.writeText=async()=>undefined })
    await expect.poll(()=>app.windows().filter(p=>p.url().includes('index.html')&&!p.url().endsWith('#hud')).length).toBe(1)
    const page=app.windows().find(p=>p.url().includes('index.html')&&!p.url().endsWith('#hud'))!
    const state=()=>page.evaluate(()=>window.terry.getState())
    const events=async()=>(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x))
    await page.evaluate(async bytes=>{
      const producer=new AudioContext(), destination=producer.createMediaStreamDestination()
      const audio=await producer.decodeAudioData(Uint8Array.from(bytes).buffer)
      ;(window as any).__producer=producer
      ;(window as any).__phaseEvents=[];window.terry.onState(s=>{const rows=(window as any).__phaseEvents; const last=rows.at(-1);if(last?.phase!==s.phase||last?.message!==s.message)rows.push({at:Date.now(),phase:s.phase,message:s.message})});
      ;(window as any).__micCalls=0;(window as any).__liveTracks=0
      ;(window as any).__speak=(mixBuzz=false)=>{
        const source=producer.createBufferSource();source.buffer=audio;source.connect(destination)
        const startAt=producer.currentTime
        const speech=audio.getChannelData(0)
        let speechOffset=0
        {
          // Put the cue over actual opening speech, not the JFK fixture's quiet
          // introduction. Keep 30 ms before its first clearly voiced 10 ms frame.
          const frameLength=Math.round(audio.sampleRate*.01)
          for(let frame=0;frame<audio.sampleRate;frame+=frameLength){
            let squares=0
            for(let i=frame;i<frame+frameLength;i++)squares+=speech[i]*speech[i]
            if(Math.sqrt(squares/frameLength)>.02){speechOffset=Math.max(0,frame/audio.sampleRate-.03);break}
          }
        }
        if(mixBuzz){
          // Exact native/audio-guard.swift activationBuzz waveform: 48 kHz,
          // 2,880 samples, 1,300 -> 800 Hz sweep and the same harmonic/envelope gain.
          const rate=48_000,count=2_880,buzz=producer.createBuffer(1,count,rate),samples=buzz.getChannelData(0)
          let phase=0,buzzSquares=0
          for(let frame=0;frame<count;frame++){
            const time=frame/rate,progress=frame/(count-1),frequency=1300-500*progress
            phase+=2*Math.PI*frequency/rate
            const attack=Math.min(1,time/.003),release=Math.min(1,(.06-time)/.012)
            samples[frame]=(Math.sin(phase)+.22*Math.sin(phase*3)+.08*Math.sin(phase*5))*attack*release*.085
            buzzSquares+=samples[frame]*samples[frame]
          }
          let speechSquares=0
          const overlapFrames=Math.round(audio.sampleRate*.06),firstFrame=Math.round(speechOffset*audio.sampleRate)
          for(let frame=firstFrame;frame<firstFrame+overlapFrames;frame++)speechSquares+=speech[frame]*speech[frame]
          ;(window as any).__buzzMix={sampleRate:rate,samples:count,durationMs:count/rate*1000,speechOffsetMs:speechOffset*1000,buzzRms:Math.sqrt(buzzSquares/count),speechOverlapRms:Math.sqrt(speechSquares/overlapFrames)}
          const cue=producer.createBufferSource();cue.buffer=buzz;cue.connect(destination);cue.start(startAt)
        }
        source.start(startAt,speechOffset)
        return Date.now()
      }
      navigator.mediaDevices.getUserMedia=async()=>{
        ;(window as any).__micCalls++;(window as any).__liveTracks++
        await producer.resume()
        const stream=destination.stream.clone(), track=stream.getAudioTracks()[0], stop=track.stop.bind(track)
        track.stop=()=>{if(track.readyState==='live')(window as any).__liveTracks--;stop()}
        return stream
      }
    },Array.from(await readFile('artifacts/jfk.wav')))
    expect(await page.evaluate(()=>(window as any).__micCalls)).toBe(0)
    await page.getByRole('button',{name:'Settings',exact:true}).click()
    const armed=page.getByRole('checkbox',{name:/Keep microphone ready/})
    await expect(armed).not.toBeChecked()
    await armed.check();await page.getByRole('button',{name:'Save settings',exact:true}).click()
    await expect.poll(()=>state().then(s=>s.microphoneReady)).toBe(true)
    expect(await page.evaluate(()=>(window as any).__micCalls)).toBe(1)
    for(const width of [1440,390]) {
      await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().endsWith('#hud'))!.setContentSize(width,920),width)
      await expect.poll(()=>page.evaluate(()=>innerWidth)).toBe(width)
      const bounds=await armed.evaluate(el=>{const r=el.closest('label')!.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height,scroll:document.documentElement.scrollWidth}})
      expect(bounds.height).toBeGreaterThanOrEqual(44);expect(bounds.left).toBeGreaterThanOrEqual(0);expect(bounds.right).toBeLessThanOrEqual(width);expect(bounds.scroll).toBeLessThanOrEqual(width)
      await page.screenshot({path:`artifacts/instant-settings-${width}.png`,fullPage:true})
    }
    await page.getByRole('button',{name:'Dictation',exact:true}).click()
    const trigger=await app.evaluate(async({BrowserWindow})=>{
      const window=BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().endsWith('#hud'))!
      // Speech begins before the key event, not after a Listening assertion.
      const started=await window.webContents.executeJavaScript('(window.__speak)()')
      ;(globalThis as any).__terryHotkey({type:'down'})
      return started
    })
    await expect.poll(()=>state().then(s=>s.phase),{intervals:[10,20,30]}).toBe('recording')
    const received=Date.now()
    expect(received-trigger).toBeLessThan(700)
    expect((await events()).some(e=>e.event==='cue-end')).toBe(false)
    expect(await page.evaluate(()=>(window as any).__micCalls)).toBe(1)
    await new Promise(resolve=>setTimeout(resolve,11_600))
    await app.evaluate(()=>(globalThis as any).__terryHotkey({type:'up'}))
    await expect.poll(()=>state().then(s=>s.phase),{timeout:30_000}).toBe('ready')
    const transcript=(await state()).transcript
    expect(transcript,JSON.stringify(await page.evaluate(()=>(window as any).__phaseEvents))).not.toBeNull()
    expect(transcript!.text).toMatch(/and so.*fellow Americans/i)
    expect(transcript!.text).toMatch(/for your country/i)
    expect(transcript!.text).not.toMatch(/hello|buzz|Terry/i)
    await expect.poll(()=>state().then(s=>s.microphoneReady)).toBe(true)
    expect(await page.evaluate(()=>(window as any).__micCalls)).toBe(1)
    await writeFile('artifacts/instant-trigger-timing.json',JSON.stringify({trigger,observedRecording:received,observedDelayMs:received-trigger,events:await events()},null,2))

    // The clean speech above is the known-good control through this same capture
    // and real Whisper path. Now deliberately mix the actual 60 ms cue into its
    // opening words, a stronger overlap than merely playing it into silence.
    await app.evaluate(async({BrowserWindow})=>{
      const window=BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().endsWith('#hud'))!
      await window.webContents.executeJavaScript('(window.__speak)(true)')
      ;(globalThis as any).__terryHotkey({type:'down'})
    })
    await expect.poll(()=>state().then(s=>s.phase),{intervals:[10,20,30]}).toBe('recording')
    const mixture=await page.evaluate(()=>(window as any).__buzzMix)
    expect(mixture).toMatchObject({sampleRate:48_000,samples:2_880,durationMs:60})
    expect(mixture.buzzRms).toBeGreaterThan(.02)
    expect(mixture.speechOverlapRms).toBeGreaterThan(.02)
    expect(await page.evaluate(()=>(window as any).__micCalls)).toBe(1)
    await new Promise(resolve=>setTimeout(resolve,11_600))
    await app.evaluate(()=>(globalThis as any).__terryHotkey({type:'up'}))
    await expect.poll(()=>state().then(s=>s.phase),{timeout:30_000}).toBe('ready')
    const mixedTranscript=(await state()).transcript
    expect(mixedTranscript).not.toBeNull()
    expect(mixedTranscript!.text).toMatch(/^\s*and so[,\s]+my fellow Americans/i)
    expect(mixedTranscript!.text).toMatch(/for your country[.!?]?\s*$/i)
    expect(mixedTranscript!.text).not.toMatch(/hello|buzz|Terry|beep|music|sound/i)
    const words=(text:string)=>text.toLowerCase().match(/[a-z]+/g)
    expect(words(mixedTranscript!.text),'The overlapping cue must neither delete speech nor add words to the clean control transcript').toEqual(words(transcript!.text))
    await expect.poll(()=>state().then(s=>s.microphoneReady)).toBe(true)
    await writeFile('artifacts/instant-buzz-overlap.json',JSON.stringify({mixture,cleanWords:words(transcript!.text)?.length,mixedWords:words(mixedTranscript!.text)?.length},null,2))

    // Start speech at key-down but hold the renderer's start command for 350 ms.
    // This models a busy UI thread and exceeds the previous 120 ms buffer.
    await app.evaluate(async({BrowserWindow})=>{
      const window=BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().endsWith('#hud'))!
      const send=window.webContents.send.bind(window.webContents)
      window.webContents.send=((channel:string,...args:any[])=>{
        if(channel==='terry:capture' && args[0]?.action==='start') setTimeout(()=>send(channel,...args),350)
        else send(channel,...args)
      }) as typeof window.webContents.send
      await window.webContents.executeJavaScript('(window.__speak)()')
      ;(globalThis as any).__terryHotkey({type:'down'})
      window.webContents.send=send
    })
    await expect.poll(()=>state().then(s=>s.phase)).toBe('recording')
    await new Promise(resolve=>setTimeout(resolve,11_600))
    await app.evaluate(()=>(globalThis as any).__terryHotkey({type:'up'}))
    await expect.poll(()=>state().then(s=>s.phase),{timeout:30_000}).toBe('ready')
    expect((await state()).transcript!.text).toMatch(/^\s*and so[,\s]+my fellow Americans/i)
    await writeFile('artifacts/onset-delay-check.json',JSON.stringify({deliveryDelayMs:350,openingPreserved:true,transcript:(await state()).transcript!.text},null,2))

    // A cancelled startup immediately followed by locked capture stays isolated.
    await app.evaluate(()=>(globalThis as any).__terryHotkey({type:'down'}))
    await page.evaluate(()=>window.terry.cancel())
    await app.evaluate(()=>{for(const type of ['up','down','up','down','up'])(globalThis as any).__terryHotkey({type})})
    await expect.poll(()=>state().then(s=>s.recordingMode)).toBe('locked')
    await expect.poll(()=>state().then(s=>s.phase)).toBe('recording')
    await new Promise(resolve=>setTimeout(resolve,450))
    await app.evaluate(()=>(globalThis as any).__terryHotkey({type:'down'}))
    await expect.poll(()=>state().then(s=>s.phase)).not.toBe('recording')
    await page.evaluate(()=>window.terry.cancel())
    await expect.poll(()=>state().then(s=>s.microphoneReady)).toBe(true)
    expect(await page.evaluate(()=>(window as any).__micCalls)).toBe(1)

    await app.evaluate(({powerMonitor})=>powerMonitor.emit('lock-screen'))
    await expect.poll(()=>page.evaluate(()=>(window as any).__liveTracks)).toBe(0)
    expect((await state()).microphoneReady).toBe(false)
    await app.evaluate(()=>{for(const type of ['down','up'])(globalThis as any).__terryHotkey({type})})
    await page.evaluate(()=>window.terry.toggle())
    expect(await page.evaluate(()=>(window as any).__liveTracks)).toBe(0)
    expect(await page.evaluate(()=>(window as any).__micCalls)).toBe(1)
    await app.evaluate(({powerMonitor})=>powerMonitor.emit('unlock-screen'))
    await expect.poll(()=>state().then(s=>s.microphoneReady)).toBe(true)
    expect(await page.evaluate(()=>(window as any).__micCalls)).toBe(2)
    // The separate input test yields ownership before a hotkey reuses readiness.
    await page.getByRole('button',{name:'Settings',exact:true}).click()
    await page.getByRole('button',{name:'Test input',exact:true}).click()
    await expect(page.getByRole('button',{name:'Stop test',exact:true})).toBeVisible()
    await app.evaluate(()=>{for(const type of ['down','up','down','up'])(globalThis as any).__terryHotkey({type})})
    await expect.poll(()=>state().then(s=>s.phase)).toBe('recording')
    await expect.poll(()=>page.evaluate(()=>(window as any).__liveTracks)).toBe(1)
    await page.evaluate(()=>window.terry.cancel())
    await expect.poll(()=>state().then(s=>s.microphoneReady)).toBe(true)
    await page.evaluate(async()=>{const s=await window.terry.getState();await window.terry.saveSettings({...s.settings,keepMicrophoneReady:false})})
    await expect.poll(()=>page.evaluate(()=>(window as any).__liveTracks)).toBe(0)
    expect((await state()).microphoneReady).toBe(false)
    await page.evaluate(()=>(window as any).__producer.close())
  } finally {await app.close();await rm(directory,{recursive:true,force:true})}
})
