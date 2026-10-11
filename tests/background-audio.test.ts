import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BackgroundAudioSession } from '../src/main/background-audio'

async function fixture(body = '') {
  const directory = await mkdtemp(join(tmpdir(), 'terry-audio-session-'))
  const executable = join(directory, 'audio guard ; literal')
  const log = join(directory, 'events.jsonl')
  await writeFile(log, '')
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const log = event => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(event) + '\\n')
const emit = event => console.log(JSON.stringify(event))
log({event:'start',pid:process.pid})
${body || `emit({type:'ready'})
readline.createInterface({input:process.stdin}).on('line', line => {
  const command = JSON.parse(line); log(command)
  if(command.action==='play') setTimeout(() => emit({type:'cue-complete',id:command.id,ok:true}), 40)
  if(command.action==='stop') process.exit(0)
})`}
`, { mode: 0o700 })
  return { directory, executable, events: async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}

test('mute helper readiness, exact cue path and acknowledged completion precede release', async () => {
  const f = await fixture()
  const failures: Error[] = []
  const session = new BackgroundAudioSession(f.executable, new AbortController().signal, error => failures.push(error))
  try {
    await session.ready
    const start = Date.now()
    await session.play('/tmp/Hello ; $(literal).mp3')
    assert.ok(Date.now() - start >= 35)
    await session.stop()
    assert.deepEqual((await f.events()).slice(1), [{ action: 'play', path: '/tmp/Hello ; $(literal).mp3', id: '1' }, { action: 'stop' }])
    assert.deepEqual(failures, [])
  } finally { await session.stop(); await rm(f.directory, { recursive: true, force: true }) }
})

test('cancellation during startup waits for the owned helper to exit', async () => {
  const f = await fixture(`setTimeout(() => emit({type:'ready'}), 10_000); process.stdin.resume(); process.stdin.on('end', () => process.exit(0))`)
  const controller = new AbortController()
  const failures: Error[] = []
  const session = new BackgroundAudioSession(f.executable, controller.signal, error => failures.push(error))
  const ready = assert.rejects(session.ready, { name: 'AbortError' })
  controller.abort()
  await ready; await session.closed
  assert.deepEqual(failures, [])
  await rm(f.directory, { recursive: true, force: true })
})

test('abort during a cue rejects playback and closes the mute lease', async () => {
  const f = await fixture(`emit({type:'ready'}); readline.createInterface({input:process.stdin}).on('line', line => { const c=JSON.parse(line); log(c); if(c.action==='stop') process.exit(0) })`)
  const controller = new AbortController()
  const session = new BackgroundAudioSession(f.executable, controller.signal, () => undefined)
  try {
    await session.ready
    const play = assert.rejects(session.play('/tmp/hello.mp3'), { name: 'AbortError' })
    await new Promise(resolve => setTimeout(resolve, 20)); controller.abort()
    await play; await session.closed
    assert.equal((await f.events()).at(-1)?.action, 'stop')
  } finally { await session.stop(); await rm(f.directory, { recursive: true, force: true }) }
})

test('unexpected helper exit cancels dictation instead of pretending music is still muted', async () => {
  const f = await fixture(`emit({type:'ready'}); setTimeout(() => process.exit(1), 60)`)
  const failures: Error[] = []
  const session = new BackgroundAudioSession(f.executable, new AbortController().signal, error => failures.push(error))
  await session.ready; await session.closed
  assert.equal(failures.length, 1); assert.match(failures[0].message, /unexpectedly/)
  await rm(f.directory, { recursive: true, force: true })
})

test('readiness timeout and malformed responses fail clearly and release the helper', async () => {
  for (const body of [`process.stdin.resume()`, `console.log('invalid'); process.stdin.resume()`]) {
    const f = await fixture(body)
    const failures: Error[] = []
    const session = new BackgroundAudioSession(f.executable, new AbortController().signal, error => failures.push(error), 250)
    await assert.rejects(session.ready, /muted in time|invalid response/)
    await session.closed
    assert.equal(failures.length, 1)
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('unresponsive helper is terminated on stop and repeated stop awaits the same close', async () => {
  const f = await fixture(`emit({type:'ready'}); process.stdin.resume(); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`)
  const session = new BackgroundAudioSession(f.executable, new AbortController().signal, () => undefined)
  await session.ready
  const first = session.stop(), second = session.stop()
  assert.equal(first, second); await first
  const pid = (await f.events())[0].pid
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  await rm(f.directory, { recursive: true, force: true })
})
