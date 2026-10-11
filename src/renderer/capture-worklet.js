const BLOCK_SIZE = 256
const LEVEL_INTERVAL_FRAMES = 1600
const MAX_PRE_ROLL_MS = 120

class TerryCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(BLOCK_SIZE)
    this.bufferOffset = 0
    this.framesSinceLevel = 0
    this.levelSquares = 0
    this.levelFrames = 0
    this.stopped = false
    this.armed = false
    this.captureId = undefined
    this.preRoll = new Float32Array(0)
    this.preRollOffset = 0
    this.preRollCount = 0
    this.prepared = false
    this.port.onmessage = event => {
      const command = event.data
      if (command?.type === 'arm') {
        this.resetBlock()
        this.armed = true
        this.stopped = false
        this.captureId = undefined
        const rate = typeof sampleRate === 'number' ? sampleRate : 16000
        const milliseconds = Math.max(0, Math.min(MAX_PRE_ROLL_MS, Number(command.preRollMs) || 0))
        this.preRoll = new Float32Array(Math.floor(rate * milliseconds / 1000))
        this.preRollOffset = 0
        this.preRollCount = 0
        this.prepared = false
        return
      }
      if (command?.type === 'begin') {
        const count = command.includePreRoll ? this.preRollCount : 0
        const samples = new Float32Array(count)
        const first = (this.preRollOffset - count + this.preRoll.length) % this.preRoll.length
        for (let index = 0; index < count; index += 1) {
          samples[index] = this.preRoll[(first + index) % this.preRoll.length]
        }
        this.preRoll.fill(0)
        this.preRollCount = 0
        this.preRollOffset = 0
        this.resetBlock()
        this.captureId = command.captureId
        this.armed = false
        this.stopped = false
        if (count > 0) this.postAudio(samples)
        return
      }
      if (command?.type !== 'flush' || command.captureId !== this.captureId) return
      this.stopped = true
      if (this.bufferOffset > 0) this.postAudio(this.buffer.slice(0, this.bufferOffset))
      this.resetBlock()
      this.port.postMessage({ type: 'flushed', requestId: command.requestId, ...this.identity() })
    }
  }

  identity() { return this.captureId === undefined ? {} : { captureId: this.captureId } }

  postAudio(samples) {
    this.port.postMessage({ type: 'audio', samples, ...this.identity() }, [samples.buffer])
  }

  resetBlock() {
    this.buffer.fill(0)
    this.bufferOffset = 0
    this.framesSinceLevel = 0
    this.levelSquares = 0
    this.levelFrames = 0
  }

  process(inputs, outputs) {
    const output = outputs[0]?.[0]
    if (output) output.fill(0)
    if (this.stopped) return true
    const input = inputs[0]?.[0]
    if (!input || input.length === 0) return true

    if (this.armed) {
      // Only this fixed-size ring exists while idle. Idle samples and levels are
      // never posted out of the audio thread, saved, or sent for transcription.
      if (this.preRoll.length > 0) {
        for (let index = 0; index < input.length; index += 1) {
          this.preRoll[this.preRollOffset] = input[index]
          this.preRollOffset = (this.preRollOffset + 1) % this.preRoll.length
          this.preRollCount = Math.min(this.preRoll.length, this.preRollCount + 1)
        }
      }
      if (!this.prepared) {
        this.prepared = true
        this.port.postMessage({ type: 'prepared' })
      }
      return true
    }

    for (let index = 0; index < input.length; index += 1) {
      const sample = input[index]
      this.buffer[this.bufferOffset] = sample
      this.bufferOffset += 1
      this.levelSquares += sample * sample
      this.levelFrames += 1
      if (this.bufferOffset === BLOCK_SIZE) {
        this.postAudio(this.buffer)
        this.buffer = new Float32Array(BLOCK_SIZE)
        this.bufferOffset = 0
      }
    }

    this.framesSinceLevel += input.length
    if (this.framesSinceLevel >= LEVEL_INTERVAL_FRAMES) {
      const level = this.levelFrames > 0 ? Math.sqrt(this.levelSquares / this.levelFrames) : 0
      this.port.postMessage({ type: 'level', level, ...this.identity() })
      this.framesSinceLevel = 0
      this.levelSquares = 0
      this.levelFrames = 0
    }
    return true
  }
}

registerProcessor('terry-capture-processor', TerryCaptureProcessor)
