import { isolatedElectron as electron } from './isolation'
import { test, expect } from '@playwright/test'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultSettings } from '../../src/main/settings'

test('speech control, silent held and locked attempts, idle edges and recovery preserve clipboard and prior transcript', async () => {
  const directory=await mkdtemp(join(tmpdir(),'terry-silence-e2e-'))
  const helper=join(directory,'helper.cjs'), log=join(directory,'paste-events')
  await mkdir('artifacts',{recursive:true});await writeFile(log,'')
  await writeFile(helper,`#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='frontmost')console.log(JSON.stringify({trusted:true,pid:111,name:'Owned test editor',bundleId:'dev.terry.test-editor',editable:true,focus:'editable'}));else if(process.argv[2]==='paste-preserving'){fs.appendFileSync(${JSON.stringify(log)},'paste\\n');console.log('{"ok":true}')}\n`,{mode:0o700})
  await writeFile(join(directory,'settings.json'),JSON.stringify({...defaultSettings(directory),modelPath:process.env.TERRY_TEST_MODEL||resolve('artifacts/ggml-tiny.en.bin'),vocabulary:'Alex, Example Studio, Terry Tibbs, Wispr Flow, Codex',autoPaste:true,muteOtherAudio:false,activationSound:'off'}))
  const app=await electron.launch({args:['.'],env:{...process.env,TERRY_E2E:'1',TERRY_USER_DATA:directory,TERRY_E2E_NATIVE_HELPER:helper}})
  try {
    await expect.poll(()=>app.windows().filter(p=>p.url().includes('index.html')&&!p.url().endsWith('#hud')).length).toBe(1)
    const page=app.windows().find(p=>p.url().includes('index.html')&&!p.url().endsWith('#hud'))!
    const hud=app.windows().find(p=>p.url().endsWith('#hud'))!
    const state=()=>page.evaluate(()=>window.terry.getState())
    const edge=(type:string)=>app.evaluate((_e,type)=>(globalThis as any).__terryHotkey({type}),type)
    const pasteCount=async()=>(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).length
    const inputs:Record<string,number[]>={}
    for(const name of ['speech','noise','buzz','hum','silence'])inputs[name]=Array.from(await readFile(`artifacts/probe-${name}.wav`))
    await page.evaluate(inputs=>{
      ;(window as any).__source='speech';(window as any).__captures=0
      navigator.mediaDevices.getUserMedia=async()=>{
        ;(window as any).__captures++
        const context=new AudioContext(),source=context.createBufferSource(),destination=context.createMediaStreamDestination()
        source.buffer=await context.decodeAudioData(Uint8Array.from(inputs[(window as any).__source]).buffer)
        source.connect(destination);await context.resume();source.start()
        const track=destination.stream.getAudioTracks()[0],stop=track.stop.bind(track)
        track.stop=()=>{stop();source.stop();void context.close()};return destination.stream
      }
    },inputs)
    // Known-good speech through the identical recording/worklet/inference path first.
    await edge('down');await expect.poll(()=>state().then(s=>s.phase)).toBe('recording')
    await page.waitForTimeout(11_300);await edge('up')
    await expect.poll(()=>state().then(s=>s.phase),{timeout:30_000}).toBe('ready')
    const previous=(await state()).transcript
    expect(previous?.text).toMatch(/fellow Americans/i);expect(previous?.text).toMatch(/country[.!]?$/i)
    expect(await pasteCount()).toBe(1)
    const content=await app.evaluate(({clipboard})=>clipboard.readText())
    expect(content).toBe('') // Mock delivery leaves the isolated clipboard intact.
    // Idle / unmatched releases must not open a microphone or copy again.
    const captureCount=await page.evaluate(()=>(window as any).__captures)
    await edge('up');await edge('up');await page.waitForTimeout(500)
    expect(await page.evaluate(()=>(window as any).__captures)).toBe(captureCount)
    for(const [index,name] of ['noise','buzz','hum','silence'].entries()) {
      await page.evaluate(name=>{(window as any).__source=name},name)
      if(index%2===0) await edge('down')
      else await app.evaluate(()=>{for(const type of ['down','up','down','up'])(globalThis as any).__terryHotkey({type})})
      await expect.poll(()=>state().then(s=>s.phase)).toBe('recording')
      if(index%2!==0) await expect(hud.locator('.hud-lock')).toBeVisible()
      await page.waitForTimeout(2_100)
      if(index%2===0)await edge('up');else {await edge('down');await edge('up')}
      await expect.poll(()=>state().then(s=>s.message),{timeout:15_000}).toBe('No speech detected. Nothing copied or pasted.')
      expect((await state()).phase).toBe('ready');expect((await state()).transcript).toEqual(previous)
      expect((await state()).canRetry).toBe(false)
      expect(await app.evaluate(({clipboard})=>clipboard.readText())).toBe(content)
      expect(await pasteCount()).toBe(1)
      await expect(hud.locator('.hud-result')).toHaveText('No speech')
    }
    const bounds=await hud.locator('.hud-result').evaluate(el=>{const a=el.getBoundingClientRect(),b=el.closest('.hud')!.getBoundingClientRect();return {fits:a.left>=b.left&&a.right<=b.right,width:b.width,height:b.height}})
    expect(bounds).toEqual({fits:true,width:104,height:28})
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('#hud'))!.showInactive())
    await hud.screenshot({path:'artifacts/silence-hud.png'})
    for(const width of [1440,390]) {
      await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().endsWith('#hud'))!;win.setContentSize(width,920);win.show();win.focus()},width)
      await expect.poll(()=>page.evaluate(()=>innerWidth)).toBe(width)
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      await page.screenshot({path:`artifacts/silence-${width}.png`,fullPage:true})
    }
    // Cancelled startup followed immediately by locked speech must recover.
    await page.evaluate(()=>{(window as any).__source='speech'})
    await edge('down');await page.evaluate(()=>window.terry.cancel());await edge('up')
    await app.evaluate(()=>{for(const type of ['down','up','down','up'])(globalThis as any).__terryHotkey({type})})
    await expect(hud.locator('.hud-lock')).toBeVisible()
    await expect.poll(()=>state().then(s=>s.phase)).toBe('recording')
    await page.waitForTimeout(11_300);await edge('down');await edge('up')
    await expect.poll(()=>state().then(s=>s.phase),{timeout:30_000}).toBe('ready')
    expect((await state()).transcript?.text).toMatch(/fellow Americans/i)
    expect(await pasteCount()).toBe(2)
    // An armed microphone matches the daily configuration. A quick silent tap
    // must not redisplay the previous Copied result or invent prompted words.
    await page.evaluate(async ()=>{(window as any).__source='silence';const s=await window.terry.getState();await window.terry.saveSettings({...s.settings,keepMicrophoneReady:true})})
    await expect.poll(()=>state().then(s=>s.microphoneReady)).toBe(true)
    await edge('down');await edge('up')
    await expect.poll(()=>state().then(s=>s.phase),{timeout:15_000}).toBe('ready')
    expect(await pasteCount()).toBe(2)
    expect((await state()).delivery).toBe('none')
    await expect(hud.locator('.hud-result')).toHaveText('No speech')
  } finally {
    await app.close();await rm(directory,{recursive:true,force:true})
  }
})
