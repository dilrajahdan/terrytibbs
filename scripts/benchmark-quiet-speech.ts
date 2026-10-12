// Public speech only. Never opens a microphone, touches the clipboard or changes settings.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { defaultSettings } from '../src/main/settings'
import { transcribeWav } from '../src/main/speech'
import { warmWhisperServer } from '../src/main/whisper-server'

const reference = 'and so my fellow americans ask not what your country can do for you ask what you can do for your country'
function errors(text: string) {
  const expected=reference.split(' '), actual=text.toLowerCase().match(/[a-z]+/g) ?? []
  let row=Array.from({length:actual.length+1},(_,i)=>i)
  for(let i=1;i<=expected.length;i++) {
    const next=[i]
    for(let j=1;j<=actual.length;j++) next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+Number(expected[i-1]!==actual[j-1]))
    row=next
  }
  return row[actual.length]
}
function amplify(wav: Buffer): Buffer {
  const output=Buffer.from(wav)
  for(let offset=12;offset+8<=output.length;) {
    const size=output.readUInt32LE(offset+4), start=offset+8
    if(output.toString('ascii',offset,offset+4)==='data') {
      let peak=0,squares=0
      for(let i=start;i<start+size;i+=2){const v=output.readInt16LE(i)/32768;peak=Math.max(peak,Math.abs(v));squares+=v*v}
      const rms=Math.sqrt(squares/(size/2)),gain=rms>0 ? Math.max(1,Math.min(8,.06/rms,.85/peak)):1
      for(let i=start;i<start+size;i+=2)output.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(output.readInt16LE(i)*gain))),i)
      return output
    }
    offset=start+size+(size&1)
  }
  throw new Error('Missing audio data')
}
async function main() {
  if(!process.argv[2])throw new Error('Usage: npx tsx scripts/benchmark-quiet-speech.ts /absolute/model.bin')
  const clean=await readFile('artifacts/jfk.wav')
  if(createHash('sha256').update(clean).digest('hex')!=='59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e')throw new Error('Expected verified public JFK fixture')
  for(const [name,filter] of [['quiet','volume=0.05'],['muffled','lowpass=f=1200,volume=0.05']]) {
    execFileSync('ffmpeg',['-y','-loglevel','error','-i','artifacts/jfk.wav','-af',filter,'-c:a','pcm_s16le',`artifacts/${name}.wav`])
  }
  const settings={...defaultSettings(resolve('artifacts/unused')),modelPath:resolve(process.argv[2])}
  const signal=AbortSignal.timeout(180000)
  const server=await warmWhisperServer({executable:resolve(settings.whisperPath,'../whisper-server'),modelPath:settings.modelPath,signal})
  const rows: Array<{sample:string;variant:string;round:number;ms:number;wordErrors:number;transcript:string}> = []
  try {
    const control=await transcribeWav(clean,settings,signal,server)
    if(errors(control.raw)!==0)throw new Error('Known-good clean control failed; do not interpret degraded inputs')
    for(let round=0;round<3;round++)for(const sample of ['clean','quiet','muffled']) {
      const wav=sample==='clean'?clean:await readFile(`artifacts/${sample}.wav`)
      for(const variant of round%2?['boost','baseline']:['baseline','boost']) {
        const start=performance.now()
        const result=await transcribeWav(variant==='boost'?amplify(wav):wav,settings,signal,server)
        rows.push({sample,variant,round,ms:Math.round(performance.now()-start),wordErrors:errors(result.raw),transcript:result.raw})
      }
    }
    const report={model:basename(settings.modelPath),referenceWords:reference.split(' ').length,rows,limitations:'One public 11-second recording with artificial attenuation/low-pass filtering, not real mumbling. Warm recognition requests, English, no vocabulary, cleanup off. Includes boost time but excludes model startup, microphone capture, VAD and paste. Normal desktop load; no personal audio.'}
    await writeFile('artifacts/quiet-speech-results.json',JSON.stringify(report,null,2))
    for(const sample of ['clean','quiet','muffled'])for(const variant of ['baseline','boost']) {
      const selected=rows.filter(r=>r.sample===sample&&r.variant===variant)
      console.log(JSON.stringify({sample,variant,wordErrors:selected.map(r=>r.wordErrors),medianMs:selected.map(r=>r.ms).sort((a,b)=>a-b)[1]}))
    }
  } finally {await server.stop()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
