// Explicit local physical check. No microphone samples are saved or transcribed.
// Prerequisite: artifacts/mute-tone.wav is a known 1 kHz, 18-second control tone.
// Run from the repository: npx electron scripts/audio-warm-physical-smoke.cjs
// An optional final argument selects an explicit diagnostic helper binary.
// Click Run in the window. This opens the real Yeti and briefly plays the tone.
const { app, BrowserWindow, ipcMain, session } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const path = require('node:path')
const readline = require('node:readline')
const fs = require('node:fs')
const os = require('node:os')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terry-warm-audio-meter-'))
const helperPath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../build/terry-audio')
const tonePath = path.resolve(__dirname, '../artifacts/mute-tone.wav')
let win, helper, control, pending, warmPromise, stopping, quitting = false
let standbyMs
const microphoneName = process.env.TERRY_PHYSICAL_INPUT || 'Yeti'
app.setName('Terry warm audio measurement')
app.setPath('userData', path.join(directory, 'user-data'))

function rejectPending(error) {
  if (!pending) return
  const current = pending
  pending = undefined
  clearTimeout(current.timer)
  current.reject(error)
}

function expect(type) {
  if (pending) return Promise.reject(new Error('A helper command is already pending.'))
  return new Promise((resolve, reject) => {
    pending = { type, resolve, reject,
      timer: setTimeout(() => rejectPending(new Error(`Timed out waiting for ${type}.`)), 5000) }
  })
}

async function warm() {
  if (warmPromise) return warmPromise
  warmPromise = (async () => {
    const started = performance.now()
    const ready = expect('standby')
    const child = spawn(helperPath, ['--standby'], { stdio: ['pipe', 'pipe', 'pipe'] })
    helper = child
    child.stderr.resume()
    child.once('error', (error) => rejectPending(error))
    child.once('close', () => {
      if (helper === child) { helper = undefined; warmPromise = undefined }
      rejectPending(new Error('The audio helper stopped.'))
    })
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let event
      try { event = JSON.parse(line) } catch { rejectPending(new Error('Invalid helper response.')); return }
      if (event.type === 'error') { rejectPending(new Error(event.message)); return }
      if (pending?.type !== event.type) return
      const current = pending
      pending = undefined
      clearTimeout(current.timer)
      if (event.ok === false) current.reject(new Error(event.message || 'The cue failed.'))
      else current.resolve(event)
    })
    await ready
    standbyMs = Math.round(performance.now() - started)
    return { standbyMs }
  })()
  try { return await warmPromise } catch (error) { warmPromise = undefined; throw error }
}

async function command(value, response) {
  if (!helper || helper.exitCode !== null) throw new Error('The audio helper is unavailable.')
  const started = performance.now()
  const result = expect(response)
  helper.stdin.write(`${JSON.stringify(value)}\n`)
  const event = await result
  return { ...event, elapsedMs: Math.round((performance.now() - started) * 10) / 10 }
}

function terminateOwned(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  // This fixture spawned this child. Show its exact identity before terminating it.
  try {
    console.log(execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'pid,ppid,command'], { encoding: 'utf8' }))
    child.kill('SIGTERM')
  } catch { /* It may have completed between the exit check and ps. */ }
}

async function closeHelper() {
  rejectPending(new Error('The physical check ended.'))
  const child = helper
  helper = undefined
  warmPromise = undefined
  if (child && child.exitCode === null && child.signalCode === null) {
    let timeout
    const closed = new Promise((resolve) => child.once('close', resolve))
    child.stdin.end(`${JSON.stringify({ action: 'stop' })}\n`)
    await Promise.race([closed, new Promise((resolve) => { timeout = setTimeout(resolve, 2000) })])
    clearTimeout(timeout)
    terminateOwned(child)
  }
}

async function stop() {
  if (stopping) return stopping
  stopping = (async () => {
    await closeHelper()
    terminateOwned(control)
    control = undefined
  })().finally(() => { stopping = undefined })
  return stopping
}

ipcMain.handle('warm', async () => {
  await warm()
  const state = await command({ action: 'status' }, 'status')
  if (!state.healthy || state.active || state.muted) throw new Error('Expected healthy, unmuted standby.')
  return { standbyMs }
})
ipcMain.handle('control', async () => {
  if (!fs.existsSync(tonePath)) throw new Error('Create artifacts/mute-tone.wav before running this check.')
  const child = spawn('/usr/bin/afplay', [tonePath], { stdio: 'ignore' })
  control = child
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  return child.pid
})
ipcMain.handle('activate', () => command({ action: 'activate', mute: true }, 'ready'))
ipcMain.handle('activate-buzz', (_event, mute) => command({ action: 'activate', mute: Boolean(mute), cue: 'buzz', id: `onset-${Date.now()}` }, 'ready'))
ipcMain.handle('buzz', () => command({ action: 'play', cue: 'buzz', id: 'physical-buzz' }, 'cue-complete'))
ipcMain.handle('release', () => command({ action: 'release' }, 'standby'))
ipcMain.handle('control-alive', () => Boolean(control && control.exitCode === null && control.signalCode === null))
ipcMain.handle('close-helper', () => closeHelper())
ipcMain.handle('stop', () => stop())
ipcMain.on('numeric-result', (_event, result) => console.log(JSON.stringify(result)))

// Reduces a rolling 1024-sample window to numeric levels on the audio thread.
// PCM is never sent to the UI or written to disk.
const workletSource = String.raw`
class ChirpMeter extends AudioWorkletProcessor {
 constructor(){
  super();this.size=1024;this.ring=new Float32Array(this.size);this.weighted=new Float32Array(this.size);
  this.window=Float32Array.from({length:this.size},(_,index)=>0.5-0.5*Math.cos(2*Math.PI*index/(this.size-1)));
  this.windowSum=this.window.reduce((sum,value)=>sum+value,0);
  this.bins=Array.from({length:14},(_,index)=>({hz:750+index*50,coefficient:2*Math.cos(2*Math.PI*(750+index*50)/sampleRate)}));
  this.cursor=0;this.filled=0;this.step=0;this.rows=[];this.lastEnd=null;this.frameGaps=[];this.totalFrames=0;
  this.port.onmessage=event=>{if(event.data.type==='flush'){this.send();this.port.postMessage({type:'flushed',id:event.data.id,totalFrames:this.totalFrames,frameGaps:this.frameGaps})}};
 }
 send(){if(this.rows.length){this.port.postMessage({type:'levels',rows:this.rows});this.rows=[]}}
 measure(endFrame){
  let squares=0;
  for(let index=0;index<this.size;index++){const value=this.ring[(this.cursor+index)%this.size];squares+=value*value;this.weighted[index]=value*this.window[index]}
  let db=-160,hz=0;
  for(const bin of this.bins){
   let previous=0,beforePrevious=0;
   for(let index=0;index<this.size;index++){const value=this.weighted[index]+bin.coefficient*previous-beforePrevious;beforePrevious=previous;previous=value}
   const power=Math.max(1e-30,previous*previous+beforePrevious*beforePrevious-bin.coefficient*previous*beforePrevious);
   const level=20*Math.log10(2*Math.sqrt(power)/this.windowSum);
   if(level>db){db=level;hz=bin.hz}
  }
  this.rows.push({frame:endFrame-this.size/2,db,hz,rms:Math.sqrt(squares/this.size)});
  if(this.rows.length>=12)this.send();
 }
 process(inputs){
  const channel=inputs[0]?.[0];if(!channel)return true;
  if(this.lastEnd!==null&&currentFrame!==this.lastEnd)this.frameGaps.push({frame:currentFrame,gap:currentFrame-this.lastEnd});
  for(let index=0;index<channel.length;index++){
   this.ring[this.cursor]=channel[index];this.cursor=(this.cursor+1)%this.size;this.filled=Math.min(this.size,this.filled+1);this.step++;
   if(this.filled===this.size&&this.step>=256){this.step=0;this.measure(currentFrame+index+1)}
  }
  this.lastEnd=currentFrame+channel.length;this.totalFrames+=channel.length;return true;
 }
}
registerProcessor('chirp-meter',ChirpMeter);
`

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'media'))
  win = new BrowserWindow({ width: 1000, height: 850, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } })
  const html = String.raw`<!doctype html><html lang="en"><meta charset="utf-8"><title>Warm audio physical check</title>
<body style="font:17px system-ui;padding:24px;background:#faf8f1;color:#191919">
<h1>Warm audio physical check</h1>
<p>Real selected microphone levels only. No microphone audio is saved or transcribed.</p>
<p>One continuous tone establishes an audible control before creating the helper, then tests standby, two mute/restore cycles, the buzz and helper shutdown.</p>
<button id="run" style="font:inherit;padding:14px 20px">Run audio check</button>
<button id="onset" style="font:inherit;padding:14px 20px">Check quick buzz timing</button>
<p id="phase" role="status">Ready. No helper has been created.</p>
<pre id="result" style="font:14px monospace;white-space:pre-wrap"></pre>
<script>
const {ipcRenderer}=require('electron');
const microphoneName=${JSON.stringify(microphoneName)};
const button=document.getElementById('run'), onsetButton=document.getElementById('onset'), phaseText=document.getElementById('phase'), output=document.getElementById('result');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
button.onclick=async()=>{
 button.disabled=true;onsetButton.disabled=true;let stream,context,timer,actual='Yeti';let phase='setup';const rows={},timings={};let controlAlive;
 const state=value=>{phase=value;phaseText.textContent=value};
 const hold=async(value,ms)=>{state(value);await wait(ms)};
 const phases=['room','control before helper','standby control','first muted','buzz','muted after buzz','first restored','second muted','second restored','helper closed restored'];
 const summary=()=>Object.fromEntries(phases.flatMap(key=>{
  // Ignore 300 ms of FFT carryover in steady phases. Keep the entire 60 ms cue.
  const values=(rows[key]||[]).slice(key==='buzz'?0:15);
  if(!values.length)return [];
  const tones=values.map(value=>value.tone).sort((a,b)=>a-b);
  return [[key,{samples:values.length,peakRms:Math.max(...values.map(value=>value.rms)),medianToneDb:tones[Math.floor(tones.length/2)]}]];
 }));
 const display=message=>{
  const values=summary();
  ipcRenderer.send('numeric-result',{message,microphone:actual,values,timings});
  output.textContent=[message,actual,'Continuous tone still running: '+String(controlAlive??'not checked'),'','Measured levels:',...Object.entries(values).map(([key,value])=>key+': '+value.samples+' samples, peak RMS '+value.peakRms.toFixed(5)+', 1 kHz median '+value.medianToneDb.toFixed(1)+' dB'),'','Protocol timing (ms): '+JSON.stringify(timings)].join('\n');
 };
 const requireAbove=(values,high,low,db)=>{
  if(!values[high]||!values[low])throw new Error('Missing measurements for '+high+' or '+low);
  const difference=values[high].medianToneDb-values[low].medianToneDb;
  if(difference<db)throw new Error(high+' was only '+difference.toFixed(1)+' dB above '+low+'; at least '+db+' dB required.');
 };
 try{
  await ipcRenderer.invoke('stop');
  const devices=await navigator.mediaDevices.enumerateDevices();
  const mic=devices.find(device=>device.kind==='audioinput'&&device.label.includes(microphoneName)&&device.deviceId!=='default');
  stream=await navigator.mediaDevices.getUserMedia({audio:{...(mic?{deviceId:{exact:mic.deviceId}}:{}),echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
  actual=stream.getAudioTracks()[0].label;
  if(!actual.includes(microphoneName))throw new Error('Expected '+microphoneName+'. Selected input: '+actual);
  context=new AudioContext();await context.resume();
  const source=context.createMediaStreamSource(stream),analyser=context.createAnalyser();
  analyser.fftSize=8192;analyser.smoothingTimeConstant=0;source.connect(analyser);
  const samples=new Float32Array(analyser.fftSize),frequencies=new Float32Array(analyser.frequencyBinCount);
  timer=setInterval(()=>{
   analyser.getFloatTimeDomainData(samples);analyser.getFloatFrequencyData(frequencies);
   const rms=Math.sqrt(samples.reduce((total,sample)=>total+sample*sample,0)/samples.length);
   let tone=-160;for(let index=Math.floor(970/context.sampleRate*analyser.fftSize);index<=Math.ceil(1030/context.sampleRate*analyser.fftSize);index++)tone=Math.max(tone,frequencies[index]);
   (rows[phase]??=[]).push({rms,tone});
  },20);
  await hold('room',1200);
  const controlPid=await ipcRenderer.invoke('control');output.textContent='Owned continuous tone PID '+controlPid;
  await hold('control before helper',2400);
  requireAbove(summary(),'control before helper','room',12);
  state('creating standby helper');const ready=await ipcRenderer.invoke('warm');timings.standbyMs=ready.standbyMs;
  await hold('standby control',1400);
  state('first activation');timings.firstMuteMs=(await ipcRenderer.invoke('activate')).elapsedMs;
  await hold('first muted',1200);
  state('buzz');timings.buzzMs=(await ipcRenderer.invoke('buzz')).elapsedMs;await wait(220);
  await hold('muted after buzz',800);
  state('first release');timings.firstReleaseMs=(await ipcRenderer.invoke('release')).elapsedMs;
  await hold('first restored',1400);
  state('second activation');timings.secondMuteMs=(await ipcRenderer.invoke('activate')).elapsedMs;
  await hold('second muted',1200);
  state('second release');timings.secondReleaseMs=(await ipcRenderer.invoke('release')).elapsedMs;
  await hold('second restored',1400);
  state('closing helper');await ipcRenderer.invoke('close-helper');
  await hold('helper closed restored',1400);
  controlAlive=await ipcRenderer.invoke('control-alive');
  if(!controlAlive)throw new Error('The continuous control tone ended before measurement finished. Repeat with the required 18-second tone.');
  const values=summary();
  requireAbove(values,'standby control','room',12);
  requireAbove(values,'standby control','first muted',12);
  requireAbove(values,'first restored','first muted',12);
  requireAbove(values,'first restored','second muted',12);
  requireAbove(values,'second restored','second muted',12);
  requireAbove(values,'helper closed restored','second muted',12);
  const buzzRatio=values.buzz.peakRms/values['first muted'].peakRms;
  if(buzzRatio<1.5)throw new Error('Buzz peak RMS was only '+buzzRatio.toFixed(2)+'x quiet background; at least 1.5x required.');
  display('PASSED physical level checks. Buzz / preceding quiet peak RMS: '+buzzRatio.toFixed(2)+'x');state('Passed. Microphone is off.');
 }catch(error){display('FAILED: '+error.message);state('Failed physical check. Microphone is off.');}
 finally{clearInterval(timer);stream?.getTracks().forEach(track=>track.stop());await context?.close();await ipcRenderer.invoke('stop');button.disabled=false;onsetButton.disabled=false;}
};
onsetButton.onclick=async()=>{
 button.disabled=true;onsetButton.disabled=true;let stream,context,timer,worklet;let actual=microphoneName;
 let stage='room',cueStarted=0;const rows={};const results={};const mediaEvents=[];
 const workletRows=[];const flushes=new Map();let flushId=0;
 const flushWorklet=()=>new Promise((resolve,reject)=>{const id=++flushId;const timeout=setTimeout(()=>{flushes.delete(id);reject(new Error('Audio-thread meter did not flush.'))},2000);flushes.set(id,value=>{clearTimeout(timeout);resolve(value)});worklet.port.postMessage({type:'flush',id})});
 const show=message=>{ipcRenderer.send('numeric-result',{message,microphone:actual,results});output.textContent=[message,actual,'No background test tone. Numeric spectrum measurements only.','',...Object.entries(results).map(([name,value])=>name+'\n'+JSON.stringify(value))].join('\n')};
 const percentile=(values,fraction)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(sorted.length*fraction))]};
 const detect=(events,threshold)=>{
  const signal=events.filter(row=>row.db>=threshold&&row.time>=0);
  for(let index=0;index<signal.length;index++){
   const start=signal[index];
   if(start.hz<1080||start.hz>1420)continue;
   const tail=signal.slice(index+1).find(row=>row.time-start.time>=15&&row.time-start.time<=90&&row.hz<=start.hz-170);
   if(tail)return {onsetMs:Math.round(start.time),startHz:Math.round(start.hz),endHz:Math.round(tail.hz),sweepMs:Math.round(tail.time-start.time)};
  }
  return null;
 };
 try{
  await ipcRenderer.invoke('stop');
  await ipcRenderer.invoke('warm');
  const devices=await navigator.mediaDevices.enumerateDevices();
  const mic=devices.find(device=>device.kind==='audioinput'&&device.label.includes(microphoneName)&&device.deviceId!=='default');
  stream=await navigator.mediaDevices.getUserMedia({audio:{...(mic?{deviceId:{exact:mic.deviceId}}:{}),echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
  actual=stream.getAudioTracks()[0].label;
  if(!actual.includes(microphoneName))throw new Error('Expected '+microphoneName+'. Selected input: '+actual);
  const track=stream.getAudioTracks()[0];
  for(const type of ['mute','unmute','ended'])track.addEventListener(type,()=>mediaEvents.push({event:type,stage,ms:Math.round(performance.now()-cueStarted)}));
  context=new AudioContext();await context.resume();
  context.addEventListener('statechange',()=>mediaEvents.push({event:'context '+context.state,stage,ms:Math.round(performance.now()-cueStarted)}));
  const source=context.createMediaStreamSource(stream),analyser=context.createAnalyser();
  analyser.fftSize=1024;analyser.smoothingTimeConstant=0;source.connect(analyser);
  await context.audioWorklet.addModule('chirp-meter.js');
  worklet=new AudioWorkletNode(context,'chirp-meter',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],channelCount:1,channelCountMode:'explicit'});
  worklet.port.onmessage=event=>{const value=event.data;if(value.type==='levels')workletRows.push(...value.rows);if(value.type==='flushed'){flushes.get(value.id)?.(value);flushes.delete(value.id)}};
  const silent=context.createGain();silent.gain.value=0;source.connect(worklet);worklet.connect(silent);silent.connect(context.destination);
  const frequencies=new Float32Array(analyser.frequencyBinCount),wave=new Float32Array(analyser.fftSize);
  timer=setInterval(()=>{
   analyser.getFloatFrequencyData(frequencies);analyser.getFloatTimeDomainData(wave);let db=-160,hz=0;
   for(let index=Math.ceil(750/context.sampleRate*analyser.fftSize);index<=Math.floor(1420/context.sampleRate*analyser.fftSize);index++){
    if(frequencies[index]>db){db=frequencies[index];hz=index*context.sampleRate/analyser.fftSize;}
   }
   const rms=Math.sqrt(wave.reduce((sum,value)=>sum+value*value,0)/wave.length);
   (rows[stage]??=[]).push({time:performance.now()-cueStarted,audioMs:context.currentTime*1000,db,hz,rms,muted:track.muted});
  },5);
  for(const [name,mute] of [['unmuted control',false],['combined mute',true]]){
   stage=name+' room';phaseText.textContent='Measuring quiet baseline before '+name;const baselineStartFrame=Math.round(context.currentTime*context.sampleRate);await wait(1200);
   await flushWorklet();
   const floor=percentile((rows[stage]||[]).map(row=>row.db),0.95);
   const audioFloor=percentile(workletRows.filter(row=>row.frame>=baselineStartFrame+2048).map(row=>row.db),0.95);
   if(!Number.isFinite(floor)||!Number.isFinite(audioFloor))throw new Error('No microphone baseline measurements.');
   stage=name;phaseText.textContent='Measuring '+name+' buzz';const commandFrame=Math.round(context.currentTime*context.sampleRate);cueStarted=performance.now();
   const response=await ipcRenderer.invoke('activate-buzz',mute);
   const readyObservedMs=Math.round(performance.now()-cueStarted);
   await wait(350);
   const audioStats=await flushWorklet();
   const measured=rows[stage]||[];
   const audioMeasured=workletRows.filter(row=>row.frame>=commandFrame).map(row=>({...row,time:(row.frame-commandFrame)/context.sampleRate*1000}));
   const found=detect(audioMeasured,audioFloor+12);
   const gaps=measured.slice(1).map((row,index)=>({at:Math.round(row.time),js:Math.round((row.time-measured[index].time)*10)/10,audio:Math.round((row.audioMs-measured[index].audioMs)*10)/10}));
   const strong=audioMeasured.filter(row=>row.db>=audioFloor+12).map(row=>({ms:Math.round(row.time),hz:Math.round(row.hz),db:Math.round(row.db),rms:Number(row.rms.toFixed(5))}));
   const repeated=measured.slice(1).filter((row,index)=>row.db===measured[index].db&&row.hz===measured[index].hz).length;
   results[name]={measurement:'AudioWorklet sample clock',baseline95thDb:Math.round(audioFloor*10)/10,peakBandDb:Math.round(Math.max(...audioMeasured.map(row=>row.db))*10)/10,readyObservedMs,readyNativeMs:response.elapsedMs,audioSampleCount:audioMeasured.length,firstAudioSampleMs:Math.round(audioMeasured[0]?.time??-1),lastAudioSampleMs:Math.round(audioMeasured.at(-1)?.time??-1),chirp:found,audioFrameGaps:audioStats.frameGaps,timer:{sampleCount:measured.length,chirp:detect(measured,floor+12),medianGapMs:percentile(gaps.map(gap=>gap.js),0.5),maxGapMs:Math.max(...gaps.map(gap=>gap.js)),gapsOver20Ms:gaps.filter(gap=>gap.js>20),zeroAudioClockSteps:gaps.filter(gap=>gap.audio===0).length,repeatedSpectrumFrames:repeated},zeroRmsFrames:audioMeasured.filter(row=>row.rms===0).length,mutedTrackFrames:measured.filter(row=>row.muted).length,strongBandTimeline:strong,mediaEvents:mediaEvents.filter(event=>event.stage===name)};
   show('Measuring quick cue onset...');
   await ipcRenderer.invoke('release');await wait(250);
   if(!found)throw new Error('No clear descending 1300–800 Hz cue detected for '+name+'. Keep the room quiet and retry.');
   if(found.onsetMs>250)throw new Error(name+' cue onset was '+found.onsetMs+' ms, above the 250 ms diagnostic bound.');
  }
  const control=results['unmuted control'].chirp.onsetMs,combined=results['combined mute'].chirp.onsetMs;
  const beforeReady=results['combined mute'].readyObservedMs-combined;
  results.comparison={additionalOnsetMs:combined-control,buzzBeforeMuteReadyMs:beforeReady};
  if(combined>control+100)throw new Error('Combined mute delayed the cue more than 100 ms beyond the unmuted control.');
  if(beforeReady<150)throw new Error('The cue was not detected at least 150 ms before mute readiness.');
  show('PASSED: physical buzz starts promptly, before the slow mute update finishes.');phaseText.textContent='Quick buzz timing passed. Microphone is off.';
 }catch(error){show('FAILED: '+error.message);phaseText.textContent='Quick buzz timing failed. Microphone is off.';}
 finally{clearInterval(timer);stream?.getTracks().forEach(track=>track.stop());worklet?.disconnect();await context?.close();await ipcRenderer.invoke('stop');button.disabled=false;onsetButton.disabled=false;}
};
</script></body></html>`
  const htmlPath = path.join(directory, 'index.html')
  fs.writeFileSync(path.join(directory, 'chirp-meter.js'), workletSource)
  fs.writeFileSync(htmlPath, html)
  win.loadFile(htmlPath)
})
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  stop().finally(() => { quitting = true; app.quit() })
})
app.on('will-quit', () => fs.rmSync(directory, { recursive: true, force: true }))
app.on('window-all-closed', () => app.quit())
