import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

test('real audio processor retains the first sample and partial tail, then stops at its flush acknowledgement', () => {
  const delivered: any[] = []
  let Processor: any
  class AudioWorkletProcessor {
    port = {
      onmessage: null as any,
      postMessage: (value: unknown, transfer: ArrayBuffer[] = []) => delivered.push(structuredClone(value, { transfer }))
    }
  }
  runInNewContext(readFileSync('src/renderer/capture-worklet.js', 'utf8'), {
    AudioWorkletProcessor, Float32Array,
    registerProcessor: (_name: string, implementation: unknown) => { Processor = implementation }
  })
  const processor = new Processor()
  const expected = Float32Array.from({ length: 1447 }, (_, index) => Math.sin(index / 19) / 4)
  for (let offset = 0; offset < expected.length; offset += 128) {
    const output = new Float32Array(128).fill(1)
    processor.process([[expected.slice(offset, offset + 128)]], [[output]])
    assert.equal(output.every(value => value === 0), true, 'The graph must never play microphone audio to speakers')
  }
  assert.ok(delivered.filter(message => message.type === 'audio').reduce((count, message) => count + message.samples.length, 0) < expected.length, 'Control must leave a real partial audio block pending')
  processor.port.onmessage({ data: { type: 'flush', requestId: 7 } })
  const actual = delivered.filter(message => message.type === 'audio').flatMap(message => Array.from(message.samples))
  assert.deepEqual(actual, Array.from(expected), 'Every first and final sample must survive, in order and exactly once')
  assert.deepEqual(delivered.at(-1), { type: 'flushed', requestId: 7 })
  const count = delivered.length
  processor.process([[new Float32Array(2048).fill(0.8)]], [[new Float32Array(2048)]])
  assert.equal(delivered.length, count, 'No new audio may cross the stop acknowledgement')
})

function armedProcessor(sampleRate = 16_000) {
  const delivered: any[] = []
  let Processor: any
  class AudioWorkletProcessor {
    port = {
      onmessage: null as any,
      postMessage: (value: unknown, transfer: ArrayBuffer[] = []) => delivered.push(structuredClone(value, { transfer }))
    }
  }
  runInNewContext(readFileSync('src/renderer/capture-worklet.js', 'utf8'), {
    AudioWorkletProcessor, Float32Array, sampleRate,
    registerProcessor: (_name: string, implementation: unknown) => { Processor = implementation }
  })
  const processor = new Processor()
  return {
    processor, delivered,
    command: (data: Record<string, unknown>) => processor.port.onmessage({ data }),
    feed: (samples: Float32Array) => {
      for (let offset = 0; offset < samples.length; offset += 128) {
        processor.process([[samples.slice(offset, offset + 128)]], [[new Float32Array(128)]])
      }
    }
  }
}

test('armed worklet keeps only the last 500 ms in memory and emits no idle audio or levels', () => {
  for (const rate of [16_000, 48_000]) {
    const subject = armedProcessor(rate)
    subject.command({ type: 'arm', preRollMs: 999_999 })
    const idle = Float32Array.from({ length: rate * 3 }, (_, index) => index / rate)
    subject.feed(idle)
    assert.equal(subject.processor.preRoll.length, Math.floor(rate * 0.5))
    assert.equal(subject.processor.preRollCount, Math.floor(rate * 0.5))
    assert.deepEqual([...subject.delivered], [{ type: 'prepared' }])
    subject.command({ type: 'begin', captureId: 30, includePreRoll: true })
    const begin = subject.delivered.at(-1)
    assert.equal(begin.type, 'audio')
    assert.equal(begin.captureId, 30)
    assert.deepEqual(Array.from(begin.samples), Array.from(idle.slice(-Math.floor(rate * 0.5))))
    assert.equal(subject.processor.preRoll.every((sample: number) => sample === 0), true, 'Promoted idle audio must be erased from its ring')
    subject.feed(new Float32Array([0.7, 0.8]))
    subject.command({ type: 'flush', captureId: 30, requestId: 1 })
    assert.deepEqual(Array.from(subject.delivered.at(-2).samples), [Math.fround(0.7), Math.fround(0.8)])
    assert.deepEqual(subject.delivered.at(-1), { type: 'flushed', captureId: 30, requestId: 1 })
  }
})

test('cue mode discards pre-roll and cancel reset cannot carry old partial samples into a new session', () => {
  const subject = armedProcessor()
  subject.command({ type: 'arm', preRollMs: 500 })
  subject.feed(new Float32Array(2048).fill(0.9))
  subject.command({ type: 'begin', captureId: 31, includePreRoll: false })
  assert.deepEqual([...subject.delivered], [{ type: 'prepared' }])
  subject.feed(new Float32Array([0.7, 0.8]))
  subject.command({ type: 'arm', preRollMs: 500 })
  subject.feed(new Float32Array([0.1, 0.2]))
  subject.command({ type: 'begin', captureId: 32, includePreRoll: true })
  subject.command({ type: 'flush', captureId: 31, requestId: 2 })
  subject.feed(new Float32Array([0.3]))
  subject.command({ type: 'flush', captureId: 32, requestId: 3 })
  const audio = subject.delivered.filter(message => message.type === 'audio')
  assert.equal(audio.every(message => message.captureId === 32), true)
  assert.deepEqual(audio.flatMap(message => Array.from(message.samples)), [0.1, 0.2, 0.3].map(Math.fround))
  assert.deepEqual(subject.delivered.at(-1), { type: 'flushed', captureId: 32, requestId: 3 })
})

test('first live audio is delivered after 16 ms at 16 kHz and partial stop tail survives', () => {
  const subject = armedProcessor()
  subject.command({ type: 'begin', captureId: 33, includePreRoll: false })
  subject.feed(new Float32Array(128).fill(0.1))
  assert.equal(subject.delivered.length, 0)
  subject.feed(new Float32Array(128).fill(0.2))
  assert.equal(subject.delivered[0]?.samples.length, 256)
  subject.feed(new Float32Array([0.3]))
  subject.command({ type: 'flush', captureId: 33, requestId: 4 })
  assert.deepEqual(Array.from(subject.delivered.at(-2).samples), [Math.fround(0.3)])
})


test('opening speech survives a 350 ms delay between shortcut and begin delivery', () => {
  const subject = armedProcessor()
  subject.command({ type: 'arm', preRollMs: 500 })
  subject.feed(new Float32Array(16_000))
  const opening = Float32Array.from({ length: 5600 }, (_, i) => Math.sin(i / 19) / 4)
  subject.feed(opening)
  subject.command({ type: 'begin', captureId: 40, includePreRoll: true })
  const retained = subject.delivered.filter(m => m.type === 'audio').flatMap(m => Array.from(m.samples))
  assert.deepEqual(retained.slice(-opening.length), Array.from(opening), 'The complete opening must survive delayed main/renderer delivery')
})
