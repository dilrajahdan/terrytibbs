import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pcmToWav } from '../src/main/speech'
import { stopWhisperServer, warmWhisperServer } from '../src/main/whisper-server'

function audibleWav(): Buffer {
  const samples = new Float32Array(16_000 * 0.4)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = 0.2 * Math.sin((2 * Math.PI * 220 * index) / 16_000)
  }
  return pcmToWav(samples)
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!existsSync(path) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(existsSync(path), true, 'fake server did not receive the request')
}

async function makeFakeServer(directory: string, capturePath: string, delayed: boolean, ready = true): Promise<string> {
  const executable = join(directory, 'whisper-server-fake')
  const source = `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
const capturePath = ${JSON.stringify(capturePath)}
const delayed = ${JSON.stringify(delayed)}
const ready = ${JSON.stringify(ready)}
const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(ready ? 200 : 503, {'content-type': 'application/json'})
    response.end(ready ? '{\\"status\\":\\"ok\\"}' : '{\\"status\\":\\"loading model\\"}')
    return
  }
  if (request.url !== '/inference') { response.writeHead(404); response.end(); return }
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    fs.writeFileSync(capturePath, Buffer.concat(chunks))
    if (delayed) return
    response.writeHead(200, {'content-type': 'application/json'})
    response.end(JSON.stringify({text: '  Hello — Alex.  '}))
  })
})
server.listen(port, '127.0.0.1')
`
  await writeFile(executable, source, { mode: 0o700 })
  await chmod(executable, 0o700)
  return executable
}

test('warmWhisperServer uses loopback multipart inference and stops its child', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-whisper-server-test-'))
  const capturePath = join(directory, 'request.bin')
  const modelPath = join(directory, 'model.bin')
  await writeFile(modelPath, 'model')
  const executable = await makeFakeServer(directory, capturePath, false)
  const server = await warmWhisperServer({ executable, modelPath, startupTimeoutMs: 5_000 })
  try {
    assert.match(server.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(server.pid > 0, true)
    assert.equal(server.running, true)
    const result = await server.transcribe(audibleWav(), { language: 'auto', vocabulary: 'Alex' }, new AbortController().signal)
    assert.equal(result, '  Hello — Alex.  ')
    const request = (await readFile(capturePath)).toString('utf8')
    assert.match(request, /name=\"language\"/)
    assert.match(request, /name=\"no_timestamps\"/)
    assert.match(request, /name=\"response_format\"/)
    assert.match(request, /name=\"prompt\"/)
    assert.match(request, /filename="input\.wav"/)
  } finally {
    const pid = server.pid
    await Promise.all([server.stop(), server.stop()])
    assert.equal(server.running, false)
    await assert.rejects(async () => process.kill(pid, 0), /ESRCH|operation not permitted/i)
  }
  await rm(directory, { recursive: true, force: true })
})

test('warmWhisperServer propagates cancellation and does not leave its child running', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-whisper-server-test-'))
  const capturePath = join(directory, 'request.bin')
  const modelPath = join(directory, 'model.bin')
  await writeFile(modelPath, 'model')
  const executable = await makeFakeServer(directory, capturePath, true)
  const server = await warmWhisperServer({ executable, modelPath, startupTimeoutMs: 5_000 })
  const controller = new AbortController()
  try {
    const request = server.transcribe(audibleWav(), { language: 'en', vocabulary: '' }, controller.signal)
    await waitForFile(capturePath)
    controller.abort()
    await assert.rejects(request, { name: 'AbortError' })
    assert.equal(server.running, false)
    await assert.rejects(async () => process.kill(server.pid, 0), /ESRCH|operation not permitted/i)
  } finally {
    await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('stopWhisperServer aborts a warm-up promise and waits for its child cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terry-whisper-server-test-'))
  const modelPath = join(directory, 'model.bin')
  await writeFile(modelPath, 'model')
  const executable = await makeFakeServer(directory, join(directory, 'unused'), false, false)
  const controller = new AbortController()
  const warming = warmWhisperServer({ executable, modelPath, startupTimeoutMs: 30_000, signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 100))
  await stopWhisperServer(warming, controller)
  await assert.rejects(warming, { name: 'AbortError' })
  await rm(directory, { recursive: true, force: true })
})
