// Real app capture, isolated profile. No personal microphone or settings are read.
// Requires a built app, TERRY_DEMO_MODEL and artifacts/tutorial/sample.mp3.
import { _electron as electron, expect } from '@playwright/test';
import {mkdtemp,writeFile,readFile,mkdir,symlink,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve('artifacts/tutorial'); await mkdir(root,{recursive:true});
const dir=await mkdtemp('/tmp/terry-tutorial-');
await symlink(process.env.TERRY_DEMO_MODEL,join(dir,'whisper-model.bin'));
await writeFile(join(dir,'settings.json'),JSON.stringify({whisperPath:'/opt/homebrew/bin/whisper-cli',modelPath:join(dir,'whisper-model.bin'),shortcut:'F13',language:'en',vocabulary:'',autoPaste:true,muteOtherAudio:false,keepMicrophoneReady:false,cleanupEnabled:false,cleanupModel:'',activationSound:'off',activationSoundDirectory:'',activationSoundClip:'',microphoneId:'',microphoneLabel:''}));
const recording=!process.argv.includes('--rehearse');
let started=Date.now(); let capturing=false; let captureWork; const frames=[];
const app=await electron.launch({args:['.'],env:{...process.env,TERRY_E2E:'1',TERRY_USER_DATA:dir}});
app.process().stderr.on('data',data=>{if(/error|Error|ffmpeg/.test(String(data)))console.error(String(data));});
const marks=[]; let page;
try{
 await expect.poll(()=>app.windows().filter(p=>p.url().includes('index.html')&&!p.url().endsWith('#hud')).length,{timeout:30000}).toBe(1);
 page=app.windows().find(p=>p.url().includes('index.html')&&!p.url().endsWith('#hud'));
 
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().endsWith('#hud')).setContentSize(1280,800));
 if(recording){started=Date.now();capturing=true;captureWork=(async()=>{while(capturing){const name=`frame-${String(frames.length).padStart(5,'0')}.jpg`;const at=(Date.now()-started)/1000;await page.screenshot({path:join(root,name),type:'jpeg',quality:85,scale:'css'});frames.push({name,at});await new Promise(r=>setTimeout(r,95));}})();}
 await page.evaluate(bytes=>{navigator.mediaDevices.getUserMedia=async()=>{const c=new AudioContext();const b=await c.decodeAudioData(Uint8Array.from(bytes).buffer);const source=c.createBufferSource();source.buffer=b;const d=c.createMediaStreamDestination();source.connect(d);await c.resume();source.start(c.currentTime+.15);const t=d.stream.getAudioTracks()[0];const stop=t.stop.bind(t);t.stop=()=>{stop();source.stop();void c.close()};return d.stream;};},Array.from(await readFile(join(root,'sample.mp3'))));
 const click=async(name)=>{const b=page.getByRole('button',{name,exact:true});await expect(b).toBeVisible();await b.scrollIntoViewIfNeeded();const r=await b.boundingBox();await page.mouse.move(r.x+r.width/2,r.y+r.height/2,{steps:12});await page.waitForTimeout(250);await b.click();};
 const shot=async(id)=>{await page.screenshot({path:join(root,id+'.png')});marks.push({id,at:(Date.now()-started)/1000});};
 await expect(page.getByRole('heading',{name:'Talk to me.'})).toBeVisible();await shot('intro'); await page.waitForTimeout(1800);
 await click('Settings');await page.getByLabel('Global shortcut',{exact:true}).evaluate(el=>el.closest('section').scrollIntoView());await shot('settings');
 await click('Record shortcut');await page.keyboard.press('Control+Shift+KeyD');await click('Use shortcut');await expect(page.getByLabel('Global shortcut',{exact:true})).toHaveValue('LeftControl+LeftShift+D');
 await click('Save settings'); await page.waitForTimeout(800); await click('Dictation');
 const edge=type=>app.evaluate((_e,type)=>globalThis.__terryHotkey({type}),type);
 await edge('down');await expect.poll(()=>page.evaluate(()=>window.terry.getState().then(s=>s.phase))).toBe('recording'); await shot('hold');await page.waitForTimeout(6500);await edge('up');
 await expect.poll(()=>page.evaluate(()=>window.terry.getState().then(s=>s.phase)),{timeout:60000}).toBe('ready');
 const state=await page.evaluate(()=>window.terry.getState()); expect(state.transcript.text.toLowerCase()).toContain('coffee');expect(state.transcript.text.toLowerCase()).toContain('friday');expect(await app.evaluate(({clipboard})=>clipboard.readText())).toBe(state.transcript.text);
 await shot('result');await page.waitForTimeout(2000);
 await app.evaluate(()=>{for(const type of ['down','up','down','up'])globalThis.__terryHotkey({type});});
 await expect.poll(()=>page.evaluate(()=>window.terry.getState().then(s=>s.recordingMode))).toBe('locked'); await shot('lock');
 const hud=app.windows().find(p=>p.url().endsWith('#hud'));await expect(hud.locator('.hud-lock')).toBeVisible();await hud.screenshot({path:join(root,'hud-lock.png')});
 await page.waitForTimeout(6500);await edge('down');await edge('up');await expect.poll(()=>page.evaluate(()=>window.terry.getState().then(s=>s.phase)),{timeout:60000}).toBe('ready');
 await shot('finish');await page.waitForTimeout(2000);await click('Close to menu bar');
 expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().endsWith('#hud')).isVisible())).toBe(false);
 await app.evaluate(()=>globalThis.__terryMenu().items.find(i=>i.label==='Open Terry Tibbs').click());
 await expect(page.getByRole('heading',{name:'Talk to me.'})).toBeVisible();
 await writeFile(join(root,'capture-evidence.json'),JSON.stringify({recording,transcript:state.transcript.text,delivery:state.delivery,marks,method:'Real app, prerecorded speech through software microphone, test-only shortcut boundary, clipboard verified. No physical keyboard or external auto-paste claim.'},null,2));
 console.log('Capture verified:',state.transcript.text);
}finally{capturing=false;if(captureWork)await captureWork;await writeFile(join(root,'frames.json'),JSON.stringify(frames));await app.close();await rm(dir,{recursive:true,force:true});}
