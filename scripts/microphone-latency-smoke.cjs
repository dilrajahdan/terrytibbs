// Explicit, temporary Yeti latency measurement. No microphone audio is saved,
// transcribed, logged, or sent to the installed Terry app.
// Run from the repository: npx electron scripts/microphone-latency-smoke.cjs
// Build-only check without starting Electron: node scripts/microphone-latency-smoke.cjs --check
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terry-microphone-latency-'))
const esbuild = require(require.resolve('esbuild', { paths: [path.dirname(require.resolve('electron-vite'))] }))

try {
  esbuild.buildSync({
    entryPoints: [path.join(root, 'src/renderer/recorder.ts')],
    outfile: path.join(directory, 'recorder.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome140',
    logLevel: 'silent'
  })
  fs.copyFileSync(path.join(root, 'src/renderer/capture-worklet.js'), path.join(directory, 'capture-worklet.js'))
  esbuild.buildSync({
    entryPoints: [path.join(root, 'src/main/warm-audio.ts')],
    outfile: path.join(directory, 'warm-audio.cjs'), bundle: true,
    format: 'cjs', platform: 'node', target: 'node22', logLevel: 'silent'
  })
} catch (error) {
  fs.rmSync(directory, { recursive: true, force: true })
  throw error
}

if (process.argv.includes('--check')) {
  console.log('Recorder and worklet diagnostic bundle checked. No microphone was opened.')
  fs.rmSync(directory, { recursive: true, force: true })
} else {
  const { app, BrowserWindow, ipcMain, session, systemPreferences } = require('electron')
  const { WarmAudioService } = require(path.join(directory, 'warm-audio.cjs'))
  let win, guard, lease
  let stoppingGuard = null
  const ensureSender = event => { if (event.sender !== win?.webContents) throw new Error('Unexpected diagnostic sender') }
  const stopGuard = async () => {
    if (stoppingGuard) return stoppingGuard
    if (!guard) return
    const owned = guard
    guard = null
    lease = null
    stoppingGuard = owned.stop().finally(() => { stoppingGuard = null })
    return stoppingGuard
  }
  ipcMain.handle('continuity-warm', async event => {
    ensureSender(event)
    if (!guard) guard = new WarmAudioService(path.join(root, 'build/terry-audio'))
    await guard.ready
    return true
  })
  ipcMain.handle('continuity-activate', async (event, mute) => {
    ensureSender(event)
    if (!guard || typeof mute !== 'boolean') throw new Error('The diagnostic audio helper is not ready')
    const started = performance.now()
    lease = await guard.activate(new AbortController().signal, () => {}, mute, 'buzz')
    const activationReadyMs = performance.now() - started
    await lease.activationCue
    return { activationReadyMs, cueAcknowledgedByMs: performance.now() - started }
  })
  ipcMain.handle('continuity-release', async event => {
    ensureSender(event)
    if (lease) { await lease.stop(); lease = null }
  })
  ipcMain.handle('continuity-stop', async event => { ensureSender(event); await stopGuard() })
  app.setName('Terry microphone latency')
  ipcMain.handle('microphone-permission', async event => {
    if (event.sender !== win?.webContents) throw new Error('Unexpected diagnostic sender')
    return systemPreferences.askForMediaAccess('microphone')
  })
  ipcMain.on('numeric-result', (event, result) => {
    if (event.sender === win?.webContents) console.log(JSON.stringify(result))
  })
  const html = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Terry microphone latency</title>
<style>body{font:16px system-ui;background:#14181b;color:#f3f6f7;max-width:780px;margin:32px auto;padding:0 24px}h1{font-size:25px}p{line-height:1.45;color:#bdc8ce}button{font:600 16px system-ui;padding:14px 20px;border-radius:8px;border:1px solid #83d9c5;background:#173c34;color:white;cursor:pointer}button:disabled{opacity:.55}#phase{color:#a6eddb}pre{font:13px ui-monospace;white-space:pre-wrap;line-height:1.5;background:#20262b;padding:18px;border-radius:8px}</style></head>
<body><h1>Physical microphone start check</h1>
<p>Measures cold and prepared startup using the real Yeti and Terry’s actual capture controller. The microphone stays open briefly between the two checks, then closes. Only timing, frame counts and levels are retained. No audio is saved or transcribed.</p>
<button id="run">Run microphone check</button>
<button id="continuity">Check audio continuity during muting</button>
<p>The continuity check also compares a short buzz without muting against the same buzz with other Mac audio muted. Capture starts 200 ms before each audio change. Other audio returns after each check.</p>
<p id="phase" role="status">Ready. Microphone is off.</p><pre id="result">Press Run to measure.</pre>
<script type="module">
import { createCaptureController } from './recorder.js'
const { ipcRenderer } = require('electron')
const button = document.getElementById('run')
const continuityButton = document.getElementById('continuity')
const phase = document.getElementById('phase')
const output = document.getElementById('result')
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
let controller = null
let streamRefs = []
let nodeRefs = []
let destroyed = false
const round = value => Math.round(value * 100) / 100
const state = value => { phase.textContent = value }
const withTimeout = (promise, milliseconds, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds)
  promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
})
function cleanUp() {
  destroyed = true
  controller?.destroy()
  controller = null
  for (const stream of streamRefs) for (const track of stream.getTracks()) track.stop()
  for (const node of nodeRefs) node.port.onmessage = null
}
window.addEventListener('beforeunload', cleanUp)
button.onclick = () => runMeasurement(false)
continuityButton.onclick = () => runMeasurement(true)
async function runMeasurement(checkContinuity) {
  button.disabled = true
  continuityButton.disabled = true
  destroyed = false
  streamRefs = []
  nodeRefs = []
  const result = { cold: null, prepared: null, continuity: null, cleanup: null }
  let current = null
  let readyResolve, readyReject, readyPromise
  let idleAudioBlocks = 0
  let idleLevelMessages = 0
  let preparingAt = 0
  let prepareTime = 0
  let preparationReported = false
  let errorMessage = null
  const makeReadyPromise = () => {
    readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    readyPromise.catch(() => {})
  }
  const createRun = (id, name) => {
    let startedResolve, startedReject, completeResolve, completeReject
    const started = new Promise((resolve, reject) => { startedResolve = resolve; startedReject = reject })
    const complete = new Promise((resolve, reject) => { completeResolve = resolve; completeReject = reject })
    // Either phase may be deliberately cancelled; avoid an unused rejection.
    complete.catch(() => {})
    return { id, name, actionAt: performance.now(), started, complete, startedResolve, startedReject, completeResolve, completeReject,
      startMs: null, blocks: 0, samples: 0, peak: 0, firstAt: null, lastAt: null, largestGapMs: 0, gapTotalMs: 0, gaps: 0,
      finalSamples: 0, finalPeak: 0, sampleRate: 16_000, stopRequestedAt: null,
      sampleSquares: 0, exactlyZeroSamples: 0, zeroRun: 0, longestZeroRun: 0,
      nearZeroSamples: 0, nearZeroRun: 0, longestNearZeroRun: 0,
      deliveryGapsOver50Ms: 0, contextAtFirst: null, contextAtLast: null,
      buckets: [] }
  }
  const describe = run => ({
    triggerToCaptureStartedMs: round(run.startMs),
    triggerToFirstAudioMessageMs: run.firstAt === null ? null : round(run.firstAt - run.actionAt),
    audioBlocks: run.blocks,
    capturedSamples: run.samples,
    largestAudioMessageGapMs: round(run.largestGapMs),
    meanAudioMessageGapMs: run.gaps ? round(run.gapTotalMs / run.gaps) : 0,
    peakLevel: round(run.peak * 100000) / 100000,
    finalSamples: run.finalSamples,
    wallCaptureMs: run.stopRequestedAt === null ? null : round(run.stopRequestedAt-run.actionAt),
    audioDurationMs: round((run.finalSamples ? run.finalSamples/16_000 : run.samples/run.sampleRate)*1000),
    sampleCoverageRatio: run.stopRequestedAt === null ? null : round((run.finalSamples ? run.finalSamples/16_000 : run.samples/run.sampleRate)/((run.stopRequestedAt-run.actionAt)/1000)*10000)/10000,
    rmsLevel: run.samples ? Math.sqrt(run.sampleSquares/run.samples) : 0,
    exactlyZeroSamples: run.exactlyZeroSamples,
    longestExactlyZeroMs: round(run.longestZeroRun/run.sampleRate*1000),
    nearZeroThreshold: 0.00001,
    nearZeroSamples: run.nearZeroSamples,
    longestNearZeroMs: round(run.longestNearZeroRun/run.sampleRate*1000),
    deliveryGapsOver50Ms: run.deliveryGapsOver50Ms,
    contextElapsedMs: run.contextAtFirst === null ? null : round((run.contextAtLast-run.contextAtFirst)*1000),
    sampleTimeBuckets: run.buckets.map((bucket,index)=>({
      fromAudioMs: index*100, samples: bucket.samples,
      rms: Math.sqrt(bucket.squares/bucket.samples), exactlyZeroSamples: bucket.zeros,
      nearZeroSamples: bucket.near, firstDeliveryMs: round(bucket.firstDeliveryMs),
      lastDeliveryMs: round(bucket.lastDeliveryMs)
    }))
  })
  try {
    state('Checking microphone permission…')
    if (!await ipcRenderer.invoke('microphone-permission')) throw new Error('Microphone permission is required for this check.')
    const devices = await navigator.mediaDevices.enumerateDevices()
    const microphone = devices.find(device => device.kind === 'audioinput' && device.deviceId !== 'default' && /Yeti/i.test(device.label))
    if (!microphone) throw new Error('No labelled Yeti input found. Connect the Yeti and allow microphone access, then retry. This check will not use another microphone.')
    if(checkContinuity) {
      state('Warming the real audio helper for both continuity cases…')
      await withTimeout(ipcRenderer.invoke('continuity-warm'),5000,'Audio helper warm-up')
    }
    makeReadyPromise()
    controller = createCaptureController({
      capturePrepared: (ready, device, message) => {
        if (ready) {
          if (!/Yeti/i.test(device?.label || '')) { readyReject(new Error('Prepared input was not the Yeti')); return }
          if (!preparationReported) {
            preparationReported = true
            prepareTime = performance.now() - preparingAt
            readyResolve()
          }
        } else if (message) readyReject(new Error(message))
      },
      captureStarted: (id, device) => {
        if (!current || current.id !== id) return
        if (!/Yeti/i.test(device.label)) { current.startedReject(new Error('Capture input was not the Yeti')); return }
        current.sampleRate = device.sampleRate || 16_000
        current.startMs = performance.now() - current.actionAt
        current.startedResolve()
      },
      captureLevel: () => {},
      captureWarning: () => {},
      captureComplete: (id, samples) => {
        if (!current || current.id !== id) return
        current.finalSamples = samples.length
        // Aggregate only. The callback never retains or exports PCM samples.
        let peak = 0
        for (let index = 0; index < samples.length; index += 1) peak = Math.max(peak, Math.abs(samples[index]))
        current.finalPeak = peak
        current.completeResolve()
      },
      captureFailed: (id, message) => {
        if (current?.id === id) {
          current.startedReject(new Error(message))
          current.completeReject(new Error(message))
        }
      }
    }, {
      workletUrl: new URL('./capture-worklet.js', import.meta.url).toString(),
      getUserMedia: async constraints => {
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        streamRefs.push(stream)
        const tracks = stream.getAudioTracks()
        if (destroyed || !tracks.length || tracks.some(track => !/Yeti/i.test(track.label))) {
          for (const track of stream.getTracks()) track.stop()
          throw new Error(destroyed ? 'Check was closed' : 'The requested exact input was not the Yeti')
        }
        return stream
      },
      createWorkletNode: context => {
        const node = new AudioWorkletNode(context, 'terry-capture-processor')
        nodeRefs.push(node)
        node.port.addEventListener('message', event => {
          const message = event.data
          if (!current) {
            if (message.type === 'audio') idleAudioBlocks += 1
            if (message.type === 'level') idleLevelMessages += 1
            return
          }
          if (message.type !== 'audio') return
          const timestamp = performance.now()
          current.sampleRate=context.sampleRate
          if (current.firstAt === null) current.firstAt = timestamp
          if (current.lastAt !== null) {
            const gap = timestamp - current.lastAt
            current.largestGapMs = Math.max(current.largestGapMs, gap)
            if(gap>50)current.deliveryGapsOver50Ms+=1
            current.gapTotalMs += gap
            current.gaps += 1
          }
          current.lastAt = timestamp
          current.blocks += 1
          if(current.contextAtFirst===null)current.contextAtFirst=context.currentTime
          current.contextAtLast=context.currentTime
          for (let index = 0; index < message.samples.length; index += 1) {
            const sample=message.samples[index], magnitude=Math.abs(sample)
            current.peak=Math.max(current.peak,magnitude)
            current.sampleSquares+=sample*sample
            current.zeroRun=sample===0?current.zeroRun+1:0
            current.nearZeroRun=magnitude<0.00001?current.nearZeroRun+1:0
            current.longestZeroRun=Math.max(current.longestZeroRun,current.zeroRun)
            current.longestNearZeroRun=Math.max(current.longestNearZeroRun,current.nearZeroRun)
            if(sample===0)current.exactlyZeroSamples+=1
            if(magnitude<0.00001)current.nearZeroSamples+=1
            const bucketIndex=Math.floor(current.samples/(current.sampleRate*.1))
            const bucket=current.buckets[bucketIndex] || (current.buckets[bucketIndex]={samples:0,squares:0,zeros:0,near:0,firstDeliveryMs:timestamp-current.actionAt,lastDeliveryMs:0})
            bucket.samples+=1;bucket.squares+=sample*sample
            if(sample===0)bucket.zeros+=1
            if(magnitude<0.00001)bucket.near+=1
            bucket.lastDeliveryMs=timestamp-current.actionAt
            current.samples+=1
          }
        })
        node.port.start()
        return node
      }
    })

    state('Cold start: opening the Yeti…')
    current = createRun(1, 'cold')
    controller.handle({ action: 'start', sessionId: 1, microphoneId: microphone.deviceId })
    await withTimeout(current.started, 8000, 'Cold microphone start')
    state('Cold capture: measuring for 800 ms…')
    await delay(800)
    current.stopRequestedAt=performance.now()
    controller.handle({ action: 'cancel', sessionId: 1 })
    result.cold = describe(current)
    current = null
    await delay(80)
    if (streamRefs.some(stream => stream.getTracks().some(track => track.readyState !== 'ended'))) throw new Error('Cold cancellation did not close every track')

    state('Preparing the Yeti for instant start…')
    idleAudioBlocks = 0
    idleLevelMessages = 0
    preparingAt = performance.now()
    controller.prepare(true, microphone.deviceId)
    await withTimeout(readyPromise, 8000, 'Microphone preparation')
    await delay(300)
    const readyIdle = { audioBlocks: idleAudioBlocks, levelMessages: idleLevelMessages }
    state('Prepared start: measuring for 800 ms…')
    current = createRun(2, 'prepared')
    controller.handle({ action: 'start', sessionId: 2, microphoneId: microphone.deviceId, includePreRoll: true })
    await withTimeout(current.started, 2000, 'Prepared microphone start')
    await delay(800)
    current.stopRequestedAt=performance.now()
    controller.handle({ action: 'stop', sessionId: 2 })
    await withTimeout(current.complete, 2500, 'Prepared microphone stop')
    result.prepared = { ...describe(current), preparationMs: round(prepareTime), idle: readyIdle }
    current = null
    if(checkContinuity) {
      result.continuity={control:null,muted:null,comparison:null}
      for(const [id,name,mute] of [[3,'control',false],[4,'muted',true]]) {
        await delay(300)
        state(name==='control'?'Control: capture starts before buzz without muting…':'Test: capture starts before combined buzz and mute…')
        current=createRun(id,name)
        controller.handle({action:'start',sessionId:id,microphoneId:microphone.deviceId,includePreRoll:false})
        await withTimeout(current.started,2000,name+' capture start')
        await delay(200)
        const activationRequestedAt=performance.now(), samplesBeforeActivation=current.samples
        // This invokes the real service, which sends one combined native
        // activate/mute/buzz command. Capture was already producing real frames.
        const activation=ipcRenderer.invoke('continuity-activate',mute)
        const [native]=await Promise.all([withTimeout(activation,6000,name+' native activation'),delay(2000)])
        current.stopRequestedAt=performance.now()
        controller.handle({action:'stop',sessionId:id})
        await withTimeout(current.complete,2500,name+' capture stop')
        result.continuity[name]={...describe(current),activationRequestedMs:round(activationRequestedAt-current.actionAt),samplesBeforeActivation,native}
        current=null
        await withTimeout(ipcRenderer.invoke('continuity-release'),3000,name+' audio restoration')
      }
      const control=result.continuity.control,muted=result.continuity.muted
      result.continuity.comparison={
        sampleCoverageRatioDifference:muted.sampleCoverageRatio-control.sampleCoverageRatio,
        largestDeliveryGapDifferenceMs:round(muted.largestAudioMessageGapMs-control.largestAudioMessageGapMs),
        longestExactlyZeroDifferenceMs:round(muted.longestExactlyZeroMs-control.longestExactlyZeroMs),
        longestNearZeroDifferenceMs:round(muted.longestNearZeroMs-control.longestNearZeroMs)
      }
    }
    cleanUp()
    await delay(80)
    const tracks = streamRefs.flatMap(stream => stream.getTracks())
    result.cleanup = { requestedStreams: streamRefs.length, totalTracks: tracks.length, endedTracks: tracks.filter(track => track.readyState === 'ended').length, liveTracks: tracks.filter(track => track.readyState === 'live').length }
    if (result.cleanup.liveTracks !== 0) throw new Error('A microphone track remained open after destruction')
    if (readyIdle.audioBlocks || readyIdle.levelMessages) throw new Error('Idle audio or level messages crossed the worklet boundary')
  } catch (error) {
    errorMessage = error.message || String(error)
  } finally {
    cleanUp()
    try { await ipcRenderer.invoke('continuity-stop') } catch(error) { errorMessage=errorMessage || error.message }
    const tracks = streamRefs.flatMap(stream => stream.getTracks())
    result.cleanup = { requestedStreams: streamRefs.length, totalTracks: tracks.length, endedTracks: tracks.filter(track => track.readyState === 'ended').length, liveTracks: tracks.filter(track => track.readyState === 'live').length }
    output.textContent = (errorMessage ? 'CHECK FAILED: ' + errorMessage + '\n\n' : 'Yeti measurements\n\n') + JSON.stringify(result, null, 2)
    state(errorMessage ? 'Check failed. Microphone is off.' : 'Complete. Microphone is off.')
    ipcRenderer.send('numeric-result', result)
    streamRefs = []
    nodeRefs = []
    button.disabled = false
    continuityButton.disabled = false
  }
}
</script></body></html>`
  fs.writeFileSync(path.join(directory, 'index.html'), html)
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(contents === win?.webContents && permission === 'media'))
    win = new BrowserWindow({ width: 850, height: 820, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } })
    win.loadFile(path.join(directory, 'index.html'))
  }).catch(error => { console.error(error.message); app.quit() })
  app.on('before-quit', event => {
    if(!guard && !stoppingGuard)return
    event.preventDefault()
    void stopGuard().finally(()=>app.quit())
  })
  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => fs.rmSync(directory, { recursive: true, force: true }))
}
