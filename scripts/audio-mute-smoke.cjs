// Explicit local physical-audio verification. Never saves microphone samples.
// Prerequisite: artifacts/mute-tone.wav must be a known 1kHz 18-second control.
// Run: npx electron scripts/audio-mute-smoke.cjs <absolute Hello clip>
const { app, BrowserWindow, ipcMain, session } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const path = require('node:path')
const readline = require('node:readline')
const fs = require('node:fs'), os = require('node:os')
const directory = fs.mkdtempSync(path.join(os.tmpdir(),'terry-audio-meter-'))
let win, guard, control
let pending, ready
const helper = path.resolve('build/terry-audio')
const cue = process.argv[2]
app.setName('Terry audio measurement')
function stop() { if(guard) {guard.stdin.end('{"action":"stop"}\n');guard=null} if(control) {control.kill('SIGTERM');control=null} }
ipcMain.handle('control', () => { control=spawn('/usr/bin/afplay',[path.resolve('artifacts/mute-tone.wav')],{stdio:'ignore'}); return control.pid })
ipcMain.handle('mute', () => new Promise((resolve,reject)=>{
 guard=spawn(helper,[],{stdio:['pipe','pipe','pipe']});ready={resolve,reject}
 guard.once('error',reject)
 readline.createInterface({input:guard.stdout}).on('line',line=>{
  const e=JSON.parse(line)
  if(e.type==='ready'){ready?.resolve(e);ready=null}
  if(e.type==='error'){ready?.reject(new Error(e.message));pending?.reject(new Error(e.message))}
  if(e.type==='cue-complete'){e.ok?pending?.resolve():pending?.reject(new Error('Cue failed'));pending=null}
 })
 guard.once('close',()=>{ready?.reject(new Error('Helper stopped'));pending?.reject(new Error('Helper stopped'))})
}))
ipcMain.handle('cue',()=>new Promise((resolve,reject)=>{pending={resolve,reject};guard.stdin.write(JSON.stringify({action:'play',path:cue,id:'probe'})+'\n')}))
ipcMain.handle('restore',()=>new Promise(resolve=>{const g=guard;guard=null;g.once('close',resolve);if(process.argv.includes('--crash')) { console.log(execFileSync('/bin/ps',['-p',String(g.pid),'-o','pid,ppid,command'],{encoding:'utf8'}));g.kill('SIGKILL') } else g.stdin.end('{"action":"stop"}\n')}))
ipcMain.handle('stop',()=>stop())
app.whenReady().then(()=>{
 session.defaultSession.setPermissionRequestHandler((_w,p,cb)=>cb(p==='media'))
 win=new BrowserWindow({width:840,height:680,webPreferences:{nodeIntegration:true,contextIsolation:false}})
 const html = String.raw`<!doctype html><html><body style="font:18px system-ui;padding:24px"><h1>Physical audio check</h1><p>Yeti level measurements only. No microphone audio is saved or transcribed.</p><p>Plays a quiet test tone, mutes it, plays Hello, then restores the tone.</p><button id="run" style="padding:16px">Run audio check</button><p id="phase">Ready</p><pre id="result" style="font:14px monospace;white-space:pre-wrap"></pre><script>
const {ipcRenderer}=require('electron');const wait=ms=>new Promise(r=>setTimeout(r,ms));
document.getElementById('run').onclick=async()=>{
 const button=document.getElementById('run');button.disabled=true;let stream,context,timer;const results={};let phase='setup';
 const state=s=>{phase=s;document.getElementById('phase').textContent=s};
 try{
  const devices=await navigator.mediaDevices.enumerateDevices();const mic=devices.find(d=>d.kind==='audioinput'&&/Yeti/.test(d.label)&&d.deviceId!=='default');
  stream=await navigator.mediaDevices.getUserMedia({audio:{...(mic?{deviceId:{exact:mic.deviceId}}:{}),echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
  const actual=stream.getAudioTracks()[0].label;if(!/Yeti/.test(actual))throw new Error('This check requires the Yeti, got '+actual);
  context=new AudioContext();await context.resume();const src=context.createMediaStreamSource(stream),a=context.createAnalyser();a.fftSize=8192;a.smoothingTimeConstant=0;src.connect(a);
  const samples=new Float32Array(a.fftSize),freq=new Float32Array(a.frequencyBinCount);
  timer=setInterval(()=>{a.getFloatTimeDomainData(samples);a.getFloatFrequencyData(freq);const rms=Math.sqrt(samples.reduce((s,x)=>s+x*x,0)/samples.length);let tone=-160;for(let i=Math.floor(970/context.sampleRate*a.fftSize);i<=Math.ceil(1030/context.sampleRate*a.fftSize);i++)tone=Math.max(tone,freq[i]);(results[phase]??=[]).push({rms,tone})},60);
  state('room');await wait(1500);const controlPid=await ipcRenderer.invoke('control');state('control');document.getElementById('result').textContent='Owned speaker control PID '+controlPid;await wait(3000);
  state('starting mute');await ipcRenderer.invoke('mute');state('muted');await wait(1600);
  state('cue');await ipcRenderer.invoke('cue');await wait(150);state('muted after cue');await wait(1000);
  state('restoring');await ipcRenderer.invoke('restore');state('restored');await wait(1800);
  const summary={microphone:actual};for(const key of ['room','control','muted','cue','muted after cue','restored']){const rows=(results[key]||[]).slice(3);const db=rows.map(r=>r.tone).sort((a,b)=>a-b);summary[key]={samples:rows.length,maxRms:Math.max(...rows.map(r=>r.rms)),medianToneDb:db[Math.floor(db.length/2)]}};
  document.getElementById('result').textContent=actual+'\n'+Object.entries(summary).filter(([key])=>key!=='microphone').map(([key,v])=>key+': '+v.samples+' samples, peak RMS '+v.maxRms.toFixed(5)+', tone '+v.medianToneDb.toFixed(1)+' dB').join('\n');state('Complete. Microphone is off.');
 }catch(e){document.getElementById('result').textContent=e.message;state('Check failed. Microphone is off.')}finally{clearInterval(timer);stream?.getTracks().forEach(t=>t.stop());await context?.close();await ipcRenderer.invoke('stop');button.disabled=false}
};</script></body></html>`
 fs.writeFileSync(path.join(directory,'index.html'),html)
 win.loadFile(path.join(directory,'index.html'))
})
app.on('before-quit',stop)
app.on('will-quit',()=>fs.rmSync(directory,{recursive:true,force:true}))
app.on('window-all-closed',()=>app.quit())
