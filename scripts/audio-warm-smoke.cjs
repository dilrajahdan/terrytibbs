// Explicit local diagnostic. Briefly toggles other Mac audio; never opens a mic.
// Run: node scripts/audio-warm-smoke.cjs [--buzz]
const { spawn, execFileSync } = require('node:child_process')
const { resolve } = require('node:path')
const { performance } = require('node:perf_hooks')
const { strict: assert } = require('node:assert')

const started = performance.now()
const child = spawn(resolve(__dirname, '../build/terry-audio'), ['--standby'], {
  stdio: ['pipe', 'pipe', 'inherit'],
})
let buffer = ''
let resolveLine
const lines = []
let exited = false
child.on('exit', () => { exited = true })
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let end
  while ((end = buffer.indexOf('\n')) >= 0) {
    const event = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    if (resolveLine) { const resolve = resolveLine; resolveLine = undefined; resolve(event) }
    else lines.push(event)
  }
})
async function next(type) {
  let timer
  const event = await Promise.race([
    lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve) => { resolveLine = resolve }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 5000) }),
  ]).finally(() => clearTimeout(timer))
  assert.equal(event.type, type, JSON.stringify(event))
  return event
}
function send(command) { child.stdin.write(`${JSON.stringify(command)}\n`) }
async function status(active, muted) {
  send({ action: 'status' })
  const event = await next('status')
  assert.equal(event.healthy, true)
  assert.equal(event.active, active)
  assert.equal(event.muted, muted)
}
async function transition(command, type) {
  const start = performance.now()
  send(command)
  await next(type)
  return Math.round((performance.now() - start) * 10) / 10
}

;(async () => {
  await next('standby')
  const coldStartMs = Math.round(performance.now() - started)
  await status(false, false)
  const activationMs = []
  const releaseMs = []
  for (let index = 0; index < 5; index++) {
    activationMs.push(await transition({ action: 'activate', mute: true }, 'ready'))
    await status(true, true)
    releaseMs.push(await transition({ action: 'release' }, 'standby'))
    await status(false, false)
  }
  await transition({ action: 'activate', mute: false }, 'ready')
  await status(true, false)
  let buzzMs
  if (process.argv.includes('--buzz')) {
    send({ action: 'play', cue: 'buzz', id: 'warm-smoke-cancelled' })
    send({ action: 'release' })
    const cancelled = await next('cue-complete')
    assert.equal(cancelled.id, 'warm-smoke-cancelled')
    assert.equal(cancelled.ok, false)
    await next('standby')
    await status(false, false)
    await transition({ action: 'activate', mute: false }, 'ready')
    const start = performance.now()
    send({ action: 'play', cue: 'buzz', id: 'warm-smoke' })
    const result = await next('cue-complete')
    assert.equal(result.id, 'warm-smoke')
    assert.equal(result.ok, true)
    buzzMs = Math.round(performance.now() - start)
  }
  await transition({ action: 'release' }, 'standby')
  await status(false, false)
  const closed = new Promise((resolve) => child.once('exit', resolve))
  child.stdin.end(`${JSON.stringify({ action: 'stop' })}\n`)
  await closed
  console.log(JSON.stringify({ coldStartMs, activationMs, releaseMs, buzzMs,
    result: 'Warm standby, mute/unmute readback, active unmuted mode and clean exit passed.' }, null, 2))
})().catch((error) => {
  console.error(error)
  if (!exited) {
    // This diagnostic created this exact child and owns its lifetime.
    console.error(execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'pid,ppid,command'], { encoding: 'utf8' }))
    child.kill('SIGTERM')
  }
  process.exitCode = 1
})
