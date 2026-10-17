import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ActivationSounds, availableSoundClips } from '../src/main/sounds'

const execFile = promisify(execFileCallback)

async function makePlayer(directory: string, capturePath: string, behavior = ''): Promise<string> {
  const executable = join(directory, 'player ; $(unsafe)')
  const source = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ pid: process.pid, args }) + '\\n')
${behavior}
`
  await writeFile(executable, source, { mode: 0o700 })
  await chmod(executable, 0o700)
  return executable
}

async function events(capturePath: string): Promise<Array<{ pid: number; args: string[] }>> {
  if (!existsSync(capturePath)) return []
  const content = await readFile(capturePath, 'utf8')
  return content.trim() ? content.trim().split('\n').map(line => JSON.parse(line) as { pid: number; args: string[] }) : []
}

async function waitForEvent(capturePath: string, count: number): Promise<Array<{ pid: number; args: string[] }>> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const current = await events(capturePath)
    if (current.length >= count) return current
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return await events(capturePath)
}

async function assertGone(pid: number): Promise<void> {
  await assert.rejects(
    execFile('kill', ['-0', String(pid)]),
    error => error && typeof error === 'object' && 'code' in error && error.code !== 0
  )
}

test('rotates sorted local clips with literal argv and skips unsafe files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-sounds-test-'))
  try {
    const clips = join(directory, 'clips')
    const capturePath = join(directory, 'events.jsonl')
    await mkdir(clips)
    await Promise.all([
      writeFile(join(clips, 'z.wav'), 'z'),
      writeFile(join(clips, 'b.mp3'), 'b'),
      writeFile(join(clips, 'a.m4a'), 'a'),
      writeFile(join(clips, 'ignore.txt'), 'ignore')
    ])
    const executable = await makePlayer(directory, capturePath)
    const sounds = new ActivationSounds(executable)
    const config = { activationSound: 'clips' as const, activationSoundDirectory: clips }

    assert.deepEqual(await sounds.play(config, new AbortController().signal), { played: true })
    assert.deepEqual(await sounds.play(config, new AbortController().signal), { played: true })
    assert.deepEqual(await sounds.play(config, new AbortController().signal), { played: true })
    assert.deepEqual(await sounds.play(config, new AbortController().signal), { played: true })

    const actual = (await events(capturePath)).map(event => event.args)
    assert.deepEqual(actual, [
      [join(clips, 'a.m4a')],
      [join(clips, 'b.mp3')],
      [join(clips, 'z.wav')],
      [join(clips, 'a.m4a')]
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('preview does not advance the per-directory activation cursor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-sounds-preview-'))
  try {
    const clips = join(directory, 'clips')
    const capturePath = join(directory, 'events.jsonl')
    await mkdir(clips)
    await writeFile(join(clips, 'a.wav'), 'a')
    await writeFile(join(clips, 'b.wav'), 'b')
    const executable = await makePlayer(directory, capturePath)
    const sounds = new ActivationSounds(executable)
    const config = { activationSound: 'clips' as const, activationSoundDirectory: clips }

    assert.deepEqual(await sounds.preview(config, new AbortController().signal), { played: true })
    assert.deepEqual(await sounds.play(config, new AbortController().signal), { played: true })
    assert.deepEqual(await sounds.preview(config, new AbortController().signal), { played: true })
    assert.deepEqual(await sounds.play(config, new AbortController().signal), { played: true })
    assert.deepEqual((await events(capturePath)).map(event => event.args), [
      [join(clips, 'a.wav')],
      [join(clips, 'a.wav')],
      [join(clips, 'b.wav')],
      [join(clips, 'b.wav')]
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a chosen short clip repeats and previews exactly without rotating or replacing missing clips', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-single-clip-'))
  try {
    const clips = join(directory, 'clips'), log = join(directory, 'events.jsonl')
    await mkdir(clips)
    await writeFile(join(clips, '01 Hello.mp3'), 'hello')
    await writeFile(join(clips, '02 Talk-to-me.wav'), 'talk')
    await writeFile(join(clips, 'ignore.txt'), 'ignore')
    const sounds = new ActivationSounds(await makePlayer(directory, log))
    const config = { activationSound: 'clips' as const, activationSoundDirectory: clips, activationSoundClip: '01 Hello.mp3' }
    await sounds.play(config, new AbortController().signal)
    await sounds.preview(config, new AbortController().signal)
    await sounds.play(config, new AbortController().signal)
    assert.deepEqual((await events(log)).map(event => event.args), Array.from({ length: 3 }, () => [join(clips, '01 Hello.mp3')]))
    assert.deepEqual(await availableSoundClips(clips), [{ name: '01 Hello.mp3', label: 'Hello' }, { name: '02 Talk-to-me.wav', label: 'Talk to me' }])
    await rm(join(clips, '01 Hello.mp3'))
    const result = await sounds.play(config, new AbortController().signal)
    assert.equal(result.played, false)
    assert.match(result.warning || '', /selected voice clip is unavailable/)
    assert.equal((await events(log)).length, 3)
    // An explicit choice has not advanced the independent rotation cursor.
    await sounds.play({ ...config, activationSoundClip: '' }, new AbortController().signal)
    assert.equal((await events(log)).at(-1)?.args[0], join(clips, '02 Talk-to-me.wav'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('serializes preview and activation playback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-sounds-serial-'))
  try {
    const clips = join(directory, 'clips')
    const capturePath = join(directory, 'events.jsonl')
    await mkdir(clips)
    await writeFile(join(clips, 'a.wav'), 'a')
    const executable = await makePlayer(directory, capturePath, 'setTimeout(() => {}, 180)')
    const sounds = new ActivationSounds(executable)
    const config = { activationSound: 'clips' as const, activationSoundDirectory: clips }
    const started = Date.now()
    const first = sounds.preview(config, new AbortController().signal)
    const second = sounds.play(config, new AbortController().signal)
    await Promise.all([first, second])
    assert.ok(Date.now() - started >= 500)
    assert.equal((await events(capturePath)).length, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('off returns immediately without starting the player', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-sounds-off-'))
  try {
    const capturePath = join(directory, 'events.jsonl')
    const executable = await makePlayer(directory, capturePath)
    const sounds = new ActivationSounds(executable)
    const config = { activationSound: 'off' as const, activationSoundDirectory: directory }
    assert.deepEqual(await sounds.play(config, new AbortController().signal), { played: false })
    assert.deepEqual(await sounds.preview(config, new AbortController().signal), { played: false })
    assert.equal(existsSync(capturePath), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('abort stops the owned player and rejects after it exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-sounds-abort-'))
  try {
    const clips = join(directory, 'clips')
    const capturePath = join(directory, 'events.jsonl')
    await mkdir(clips)
    await writeFile(join(clips, 'a.wav'), 'a')
    const executable = await makePlayer(directory, capturePath, 'setInterval(() => {}, 1000)')
    const sounds = new ActivationSounds(executable)
    const controller = new AbortController()
    const pending = sounds.play({ activationSound: 'clips', activationSoundDirectory: clips }, controller.signal)
    const started = await waitForEvent(capturePath, 1)
    assert.equal(started.length, 1)
    const cancelledAt = Date.now()
    controller.abort()
    await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError')
    assert.ok(Date.now() - cancelledAt >= 140)
    await assertGone(started[0].pid)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('nonzero playback exits still wait for the settling window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-sounds-nonzero-'))
  try {
    const clips = join(directory, 'clips')
    const capturePath = join(directory, 'events.jsonl')
    await mkdir(clips)
    await writeFile(join(clips, 'a.wav'), 'a')
    const executable = await makePlayer(directory, capturePath, 'setTimeout(() => process.exit(3), 180)')
    const sounds = new ActivationSounds(executable)
    const startedAt = Date.now()
    const result = await sounds.play({ activationSound: 'clips', activationSoundDirectory: clips }, new AbortController().signal)
    assert.deepEqual(result, { played: false, warning: 'The activation sound could not be played.' })
    assert.ok(Date.now() - startedAt >= 300)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('timeout stops a long player and returns a warning after it exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-sounds-timeout-'))
  try {
    const clips = join(directory, 'clips')
    const capturePath = join(directory, 'events.jsonl')
    await mkdir(clips)
    await writeFile(join(clips, 'a.wav'), 'a')
    const executable = await makePlayer(directory, capturePath, 'setInterval(() => {}, 1000)')
    const sounds = new ActivationSounds(executable)
    const startedAt = Date.now()
    const result = await sounds.play({ activationSound: 'clips', activationSoundDirectory: clips }, new AbortController().signal)
    const started = await events(capturePath)
    assert.deepEqual(result, { played: false, warning: 'The activation sound took too long and was stopped.' })
    assert.equal(started.length, 1)
    assert.ok(Date.now() - startedAt >= 4_100)
    await assertGone(started[0].pid)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('missing or relative clip directories return a warning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-sounds-missing-'))
  try {
    const sounds = new ActivationSounds(join(directory, 'missing-player'))
    assert.deepEqual(
      await sounds.play({ activationSound: 'clips', activationSoundDirectory: join(directory, 'missing') }, new AbortController().signal),
      { played: false, warning: 'No playable local activation clips were found.' }
    )
    assert.deepEqual(
      await sounds.play({ activationSound: 'clips', activationSoundDirectory: 'relative' }, new AbortController().signal),
      { played: false, warning: 'No playable local activation clips were found.' }
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('abort after player exit cannot bypass the audio settling tail', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-sounds-tail-'))
  try {
    const clips = join(directory, 'clips')
    const capturePath = join(directory, 'events.jsonl')
    await mkdir(clips)
    await writeFile(join(clips, 'a.wav'), 'a')
    const executable = await makePlayer(directory, capturePath)
    const sounds = new ActivationSounds(executable)
    const controller = new AbortController()
    let settleStartedAt = 0
    const realSetTimeout = globalThis.setTimeout
    // Abort as the real close handler starts its settling timer. Polling for a
    // dead PID can observe exit late on a busy runner and undercount the tail.
    context.mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      if (delay === 150) {
        settleStartedAt = performance.now()
        queueMicrotask(() => controller.abort())
      }
      return realSetTimeout(callback, delay, ...args)
    }) as typeof setTimeout)
    const pending = sounds.play({ activationSound: 'clips', activationSoundDirectory: clips }, controller.signal)
    await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError')
    assert.ok(settleStartedAt > 0, 'The real player close handler must start the settling timer')
    assert.ok(performance.now() - settleStartedAt >= 100, 'Cancellation must not skip the remaining 150 ms settling window')
    const started = await events(capturePath)
    assert.equal(started.length, 1)
    await assertGone(started[0].pid)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
