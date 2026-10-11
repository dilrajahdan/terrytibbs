import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const files = [
  ['jfk.wav', 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav', '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e'],
  ['ggml-tiny.en.bin', 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.en.bin', '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f']
]
await mkdir('artifacts', { recursive: true })
for (const [name, url, sha] of files) {
  const path = resolve('artifacts', name)
  let data = await readFile(path).catch(() => null)
  if (!data || createHash('sha256').update(data).digest('hex') !== sha) {
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) })
    if (!response.ok) throw new Error(`Cannot download ${name}: ${response.status}`)
    data = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(data).digest('hex') !== sha) throw new Error(`Fixture checksum mismatch: ${name}`)
    await writeFile(path, data)
  }
}

// Deliberately non-speech inputs alongside the independent public speech control.
// These expose prompt leakage without recording anyone's room or microphone.
function wav(samples) {
  const b=Buffer.alloc(44+samples.length*2)
  b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16)
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34)
  b.write('data',36);b.writeUInt32LE(samples.length*2,40)
  for(let i=0;i<samples.length;i++)b.writeInt16LE(Math.round(samples[i]*(samples[i]<0?32768:32767)),44+i*2)
  return b
}
let seed=42
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296*2-1}
const buzz=new Float32Array(32000);let phase=0
for(let i=0;i<960;i++){
  const t=i/16000;phase+=2*Math.PI*(1300-500*i/959)/16000
  buzz[i]=(Math.sin(phase)+.22*Math.sin(phase*3)+.08*Math.sin(phase*5))*Math.min(1,t/.003)*Math.min(1,(.06-t)/.012)*.085
}
for(const [name,samples] of [
  ['silence',new Float32Array(32000)],
  ['noise',Float32Array.from({length:32000},()=>random()*.008)],
  ['buzz',buzz],
  ['hum',Float32Array.from({length:32000},(_,i)=>.01*Math.sin(2*Math.PI*60*i/16000))]
]) await writeFile(resolve('artifacts',`probe-${name}.wav`),wav(samples))
await writeFile(resolve('artifacts','probe-speech.wav'),await readFile(resolve('artifacts','jfk.wav')))
