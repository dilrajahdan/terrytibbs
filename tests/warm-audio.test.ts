import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WarmAudioService } from '../src/main/warm-audio'

async function fixture(body = '') {
  const directory = await mkdtemp(join(tmpdir(), 'terry-warm-audio-'))
  const executable = join(directory, 'warm guard ; literal')
  const log = join(directory, 'events.jsonl')
  await writeFile(log, '')
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs')
const readline = require('node:readline')
const log = event => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(event) + '\\n')
const emit = event => console.log(JSON.stringify(event))
const gate = ${JSON.stringify(join(directory, 'gate'))}
log({event:'start',pid:process.pid,args:process.argv.slice(2)})
${body || `emit({type:'standby'})
readline.createInterface({input:process.stdin}).on('line', line => {
  const command = JSON.parse(line); log(command)
  if(command.action==='activate') emit({type:'ready',muted:command.mute})
  if(command.action==='release') emit({type:'standby'})
  if(command.action==='play') setTimeout(() => emit({type:'cue-complete',id:command.id,ok:true}), 20)
  if(command.action==='stop') process.exit(0)
})`}
`, { mode: 0o700 })
  return { directory, executable, events: async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}

// Node fixtures can start much more slowly than the packaged native helper under parallel test load.
const fixtureTimeouts = { startupMs: 10_000 }
const shortTimeouts = { ...fixtureTimeouts, activateMs: 120, releaseMs: 120, playMs: 120, terminateMs: 30, killMs: 70 }

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Fixture did not reach the expected state')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('warm helper is reused with exclusive leases, exact paths, built-in buzz and optional muting', async () => {
  const f = await fixture()
  const service = new WarmAudioService(f.executable, fixtureTimeouts)
  const failures: Error[] = []
  try {
    await service.ready
    assert.equal(service.running, true)
    const first = await service.activate(new AbortController().signal, error => failures.push(error))
    await first.play('/tmp/Hello ; $(literal).mp3')
    const secondWork = service.activate(new AbortController().signal, error => failures.push(error), false)
    await first.stop()
    const second = await secondWork
    await first.stop() // A stale lease cannot restore a subsequent recording's audio.
    await assert.rejects(first.buzz(), { name: 'AbortError' })
    await second.buzz()
    await second.stop()
    assert.equal(service.running, true)
    await service.stop()
    const events = await f.events()
    assert.deepEqual(events[0].args, ['--standby'])
    assert.deepEqual(events.slice(1), [
      { action: 'activate', mute: true },
      { action: 'play', path: '/tmp/Hello ; $(literal).mp3', id: '1' },
      { action: 'release' },
      { action: 'activate', mute: false },
      { action: 'play', cue: 'buzz', id: '2' },
      { action: 'release' },
      { action: 'stop' }
    ])
    assert.deepEqual(failures, [])
  } finally { await service.stop(); await rm(f.directory, { recursive: true, force: true }) }
})

test('abort during activation waits for restore before a queued restart can activate', async () => {
  const f = await fixture(`emit({type:'standby'})
readline.createInterface({input:process.stdin}).on('line', line => {
  const c=JSON.parse(line); log(c)
  if(c.action==='activate') { const timer = setInterval(() => { if(fs.existsSync(gate)) { clearInterval(timer); emit({type:'ready'}) } }, 5) }
  if(c.action==='release') setTimeout(() => { log({event:'restored'}); emit({type:'standby'}) }, 45)
  if(c.action==='stop') process.exit(0)
})`)
  const service = new WarmAudioService(f.executable, fixtureTimeouts)
  const controller = new AbortController()
  const failures: Error[] = []
  try {
    await service.ready
    const first = assert.rejects(service.activate(controller.signal, error => failures.push(error), true, 'buzz'), { name: 'AbortError' })
    await until(async () => (await f.events()).some(event => event.action === 'activate'))
    controller.abort()
    let returnedToIdle = false
    const idle = service.idle.then(() => { returnedToIdle = true })
    const secondWork = service.activate(new AbortController().signal, error => failures.push(error))
    await first
    assert.equal(returnedToIdle, false, 'The rejected activation must still restore its native lease')
    await writeFile(join(f.directory, 'gate'), '')
    await idle
    assert.ok((await f.events()).some(event => event.event === 'restored'))
    const second = await secondWork
    assert.deepEqual((await f.events()).slice(1).map(event => event.action ?? event.event), ['activate', 'release', 'restored', 'activate'])
    assert.deepEqual((await f.events())[1], { action: 'activate', mute: true, cue: 'buzz', id: '1' })
    assert.equal(second.activationCue, undefined)
    await second.stop()
    assert.deepEqual(failures, [])
  } finally { await service.stop(); await rm(f.directory, { recursive: true, force: true }) }
})

test('combined activation buzz accepts completion before or after mute readiness', async () => {
  for (const cueFirst of [true, false]) {
    const f = await fixture(`emit({type:'standby'})
readline.createInterface({input:process.stdin}).on('line', line => {
  const c=JSON.parse(line); log(c)
  if(c.action==='activate') {
    const ready = () => { log({event:'ready'}); emit({type:'ready'}) }
    const completed = () => { log({event:'cue-complete'}); emit({type:'cue-complete',id:c.id,ok:true}) }
    ${cueFirst ? 'completed()' : 'ready()'}
    const timer = setInterval(() => { if(fs.existsSync(gate)) { clearInterval(timer); ${cueFirst ? 'ready()' : 'completed()'} } }, 5)
  }
  if(c.action==='play') emit({type:'cue-complete',id:c.id,ok:true})
  if(c.action==='release') emit({type:'standby'})
  if(c.action==='stop') process.exit(0)
})`)
    const service = new WarmAudioService(f.executable, fixtureTimeouts)
    const failures: Error[] = []
    try {
      let acquired = false
      const activation = service.activate(new AbortController().signal, error => failures.push(error), true, 'buzz')
        .then(lease => { acquired = true; return lease })
      if (cueFirst) {
        await until(async () => (await f.events()).some(event => event.event === 'cue-complete'))
        assert.equal(acquired, false, 'Cue completion cannot stand in for mute readiness')
        await writeFile(join(f.directory, 'gate'), '')
      }
      const lease = await activation
      assert.ok(lease.activationCue)
      if (!cueFirst) {
        let completed = false
        void lease.activationCue.then(() => { completed = true })
        await Promise.resolve()
        assert.equal(completed, false, 'Mute readiness cannot stand in for cue completion')
        await assert.rejects(lease.buzz(), /already playing/)
        await writeFile(join(f.directory, 'gate'), '')
      }
      await lease.activationCue
      await lease.play('/tmp/next.wav')
      await lease.stop()
      const commands = (await f.events()).filter(event => event.action)
      assert.deepEqual(commands, [
        { action: 'activate', mute: true, cue: 'buzz', id: '1' },
        { action: 'play', path: '/tmp/next.wav', id: '2' },
        { action: 'release' }
      ])
      assert.deepEqual(failures, [])
    } finally { await service.stop(); await rm(f.directory, { recursive: true, force: true }) }
  }
})

test('combined cue failure stays recoverable and lease release cancels a pending activation cue', async () => {
  const f = await fixture(`emit({type:'standby'})
readline.createInterface({input:process.stdin}).on('line', line => {
  const c=JSON.parse(line); log(c)
  if(c.action==='activate') {
    if(c.id==='1') emit({type:'cue-complete',id:c.id,ok:false})
    emit({type:'ready'})
  }
  if(c.action==='release') emit({type:'standby'})
  if(c.action==='stop') process.exit(0)
})`)
  const service = new WarmAudioService(f.executable, fixtureTimeouts)
  const failures: Error[] = []
  try {
    const first = await service.activate(new AbortController().signal, error => failures.push(error), false, 'buzz')
    assert.ok(first.activationCue)
    await assert.rejects(first.activationCue, { name: 'ActivationSoundError' })
    await first.stop()
    const second = await service.activate(new AbortController().signal, error => failures.push(error), true, 'buzz')
    assert.ok(second.activationCue)
    const cancelledCue = assert.rejects(second.activationCue, { name: 'AbortError' })
    await second.stop(); await cancelledCue
    assert.equal(service.running, true)
    assert.deepEqual(failures, [])
  } finally { await service.stop(); await rm(f.directory, { recursive: true, force: true }) }
})

test('aborted queued lease never activates or interrupts its current owner', async () => {
  const f = await fixture()
  const service = new WarmAudioService(f.executable, fixtureTimeouts)
  try {
    const first = await service.activate(new AbortController().signal, () => assert.fail('Unexpected failure'))
    const controller = new AbortController()
    const waiting = assert.rejects(service.activate(controller.signal, () => assert.fail('Cancelled request failed')), { name: 'AbortError' })
    controller.abort()
    await waiting
    await first.buzz()
    await first.stop()
    const third = await service.activate(new AbortController().signal, () => assert.fail('Unexpected failure'))
    await third.stop()
    assert.equal((await f.events()).filter(event => event.action === 'activate').length, 2)
  } finally { await service.stop(); await rm(f.directory, { recursive: true, force: true }) }
})

test('abort during playback rejects the cue and returns the same process to standby', async () => {
  const f = await fixture(`emit({type:'standby'})
readline.createInterface({input:process.stdin}).on('line', line => {
  const c=JSON.parse(line); log(c)
  if(c.action==='activate') emit({type:'ready'})
  if(c.action==='release') emit({type:'standby'})
  if(c.action==='stop') process.exit(0)
})`)
  const service = new WarmAudioService(f.executable, fixtureTimeouts)
  const controller = new AbortController()
  try {
    const lease = await service.activate(controller.signal, () => assert.fail('Cancellation is not a failure'))
    const playback = assert.rejects(lease.buzz(), { name: 'AbortError' })
    await until(async () => (await f.events()).some(event => event.action === 'play'))
    controller.abort()
    await playback; await lease.stop()
    assert.equal(service.running, true)
    assert.equal((await f.events()).at(-1).action, 'release')
  } finally { await service.stop(); await rm(f.directory, { recursive: true, force: true }) }
})

test('cue acknowledgements require matching IDs; playback failures remain recoverable', async () => {
  const f = await fixture(`emit({type:'standby'})
readline.createInterface({input:process.stdin}).on('line', line => {
  const c=JSON.parse(line); log(c)
  if(c.action==='activate') emit({type:'ready'})
  if(c.action==='release') emit({type:'standby'})
  if(c.action==='play') {
    emit({type:'cue-complete',id:'wrong-id',ok:true})
    setTimeout(() => emit({type:'cue-complete',id:c.id,ok:c.id!=='2'}), 55)
  }
  if(c.action==='stop') process.exit(0)
})`)
  const service = new WarmAudioService(f.executable, fixtureTimeouts)
  const failures: Error[] = []
  try {
    const lease = await service.activate(new AbortController().signal, error => failures.push(error))
    const start = Date.now()
    const cue = lease.buzz()
    await assert.rejects(lease.buzz(), /already playing/)
    await cue
    assert.ok(Date.now() - start >= 50)
    await assert.rejects(lease.play('/tmp/missing.mp3'), { name: 'ActivationSoundError' })
    await lease.buzz()
    assert.equal(service.running, true)
    assert.deepEqual(failures, [])
    await lease.stop()
  } finally { await service.stop(); await rm(f.directory, { recursive: true, force: true }) }
})

test('active helper crash notifies its owner exactly once and rejects pending audio', async () => {
  const f = await fixture(`emit({type:'standby'})
readline.createInterface({input:process.stdin}).on('line', line => {
  const c=JSON.parse(line); log(c)
  if(c.action==='activate') emit({type:'ready'})
  if(c.action==='play') process.exit(1)
  if(c.action==='stop') process.exit(0)
})`)
  const service = new WarmAudioService(f.executable, fixtureTimeouts)
  const failures: Error[] = []
  try {
    const lease = await service.activate(new AbortController().signal, error => failures.push(error))
    await assert.rejects(lease.buzz(), /unexpectedly/)
    await service.idle; await lease.stop()
    assert.equal(service.running, false)
    assert.equal(failures.length, 1)
    await assert.rejects(service.activate(new AbortController().signal, () => assert.fail('A later caller must not receive the old failure callback')), /unexpectedly/)
  } finally { await service.stop(); await rm(f.directory, { recursive: true, force: true }) }
})

test('idle crash cannot cancel a future lease; a replacement service works', async () => {
  const f = await fixture(`emit({type:'standby'}); setTimeout(() => process.exit(1), 30)`)
  const service = new WarmAudioService(f.executable, fixtureTimeouts)
  try {
    await service.ready; await service.closed
    assert.equal(service.running, false)
    await assert.rejects(service.activate(new AbortController().signal, () => assert.fail('No active lease existed')), /unexpectedly/)
    const replacementFixture = await fixture()
    const replacement = new WarmAudioService(replacementFixture.executable, fixtureTimeouts)
    try {
      const lease = await replacement.activate(new AbortController().signal, () => assert.fail('Replacement failed'))
      await lease.buzz(); await lease.stop()
    } finally { await replacement.stop(); await rm(replacementFixture.directory, { recursive: true, force: true }) }
  } finally { await service.stop(); await rm(f.directory, { recursive: true, force: true }) }
})

test('startup timeout, malformed and oversized responses retire the helper without unhandled rejection', async () => {
  for (const body of [
    `process.stdin.resume()`,
    `console.log('invalid'); process.stdin.resume()`,
    `console.log('x'.repeat(16385)); process.stdin.resume()`
  ]) {
    const f = await fixture(body)
    const service = new WarmAudioService(f.executable, { ...shortTimeouts, startupMs: 300 })
    try {
      await assert.rejects(service.ready, /in time|invalid response/)
      await service.closed
      assert.equal(service.running, false)
    } finally { await service.stop(); await rm(f.directory, { recursive: true, force: true }) }
  }
})

test('activate, playback and restore timeouts fail closed and release the native process', async () => {
  for (const missing of ['activate', 'play', 'release']) {
    const f = await fixture(`emit({type:'standby'})
readline.createInterface({input:process.stdin}).on('line', line => {
  const c=JSON.parse(line); log(c)
  if(c.action===${JSON.stringify(missing)}) return
  if(c.action==='activate') emit({type:'ready'})
  if(c.action==='release') emit({type:'standby'})
  if(c.action==='play') emit({type:'cue-complete',id:c.id,ok:true})
  if(c.action==='stop') process.exit(0)
})`)
    const service = new WarmAudioService(f.executable, shortTimeouts)
    const failures: Error[] = []
    try {
      if (missing === 'activate') await assert.rejects(service.activate(new AbortController().signal, error => failures.push(error)), /muted in time/)
      else {
        const lease = await service.activate(new AbortController().signal, error => failures.push(error))
        if (missing === 'play') await assert.rejects(lease.buzz(), /took too long/)
        await lease.stop()
      }
      await service.closed
      assert.equal(failures.length, 1)
      assert.equal(service.running, false)
    } finally { await service.stop(); await rm(f.directory, { recursive: true, force: true }) }
  }
})

test('cancelling cold startup leaves warm-up available for the next request', async () => {
  const f = await fixture(`setTimeout(() => emit({type:'standby'}), 60)
readline.createInterface({input:process.stdin}).on('line', line => {
  const c=JSON.parse(line); log(c)
  if(c.action==='activate') emit({type:'ready'})
  if(c.action==='release') emit({type:'standby'})
  if(c.action==='stop') process.exit(0)
})`)
  const service = new WarmAudioService(f.executable, fixtureTimeouts)
  const controller = new AbortController()
  try {
    const first = assert.rejects(service.activate(controller.signal, () => assert.fail('Cancelled')), { name: 'AbortError' })
    controller.abort(); await first
    const second = await service.activate(new AbortController().signal, () => assert.fail('Unexpected failure'))
    await second.stop()
    assert.equal((await f.events()).filter(event => event.action === 'activate').length, 1)
  } finally { await service.stop(); await rm(f.directory, { recursive: true, force: true }) }
})

test('stopping an unresponsive warm helper is idempotent and waits for process termination', async () => {
  const f = await fixture(`emit({type:'standby'}); process.stdin.resume(); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`)
  const service = new WarmAudioService(f.executable, shortTimeouts)
  try {
    await service.ready
    const first = service.stop(), second = service.stop()
    assert.equal(first, second)
    await first
    const pid = (await f.events())[0].pid
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally { await service.stop(); await rm(f.directory, { recursive: true, force: true }) }
})
