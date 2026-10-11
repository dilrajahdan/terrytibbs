import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { hasSpeechSegments, requireSpeech, NoSpeechError } from '../src/main/voice-activity'

test('speech detector requires a complete explicit result, never empty output or a guessed match', () => {
  assert.equal(hasSpeechSegments('\nDetected 0 speech segments:\n\n'), false)
  assert.equal(hasSpeechSegments('Detected 1 speech segments:\nSpeech segment 0: start = 0.00, end = 12.80\n'), true)
  for (const output of ['', 'error', 'Detected 1 speech segments:', 'Detected 0 speech segments:\nSpeech segment 0: start = 0.00, end = 12.80', 'Detected 1 speech segments:\nSpeech segment 0: start = 9.00, end = 1.00']) {
    assert.throws(() => hasSpeechSegments(output), /invalid/)
  }
})

async function fixture(behavior: string) {
  const directory = await mkdtemp(join(tmpdir(), 'terry-vad-test-'))
  const log = join(directory, 'invocation.json'), model = join(directory, 'model.bin')
  await writeFile(model, 'fixture')
  await writeFile(join(directory, 'whisper-vad-speech-segments'), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const file=args[args.indexOf('-f')+1];fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({args,file,mode:fs.statSync(file).mode & 511,dirMode:fs.statSync(require('node:path').dirname(file)).mode & 511}));${behavior}\n`, {mode:0o700})
  return {directory, log, model, whisper:join(directory, 'whisper ; $(literal)')}
}

test('guard rejects no-speech and detector errors, removes private audio and uses literal arguments', async () => {
  for (const scenario of [
    {behavior:`console.log('Detected 1 speech segments:\\nSpeech segment 0: start = 0.00, end = 12.80')`, ok:true},
    {behavior:`console.log('Detected 0 speech segments:')`, error:NoSpeechError},
    {behavior:`console.log('unparseable')`, error:/invalid result/},
    {behavior:`process.exit(3)`, error:/detector failed/}
  ]) {
    const f=await fixture(scenario.behavior)
    try {
      const run=()=>requireSpeech(Buffer.from('test audio'),f.whisper,f.model,new AbortController().signal)
      if(scenario.ok) await run(); else await assert.rejects(run,scenario.error!)
      const saved=JSON.parse(await readFile(f.log,'utf8'))
      assert.equal(saved.mode,0o600);assert.equal(saved.dirMode,0o700)
      assert.equal(saved.args[saved.args.indexOf('-vm')+1],f.model)
      assert.equal(existsSync(dirname(saved.file)),false)
    } finally { await rm(f.directory,{recursive:true,force:true}) }
  }
})

test('cancelling a running detector terminates it before removing private audio', async () => {
  const f=await fixture(`setInterval(()=>{},1000)`)
  try {
    const controller=new AbortController()
    const pending=requireSpeech(Buffer.from('test audio'),f.whisper,f.model,controller.signal)
    const rejected=assert.rejects(pending,{name:'AbortError'})
    const deadline=Date.now()+3000
    while(!existsSync(f.log) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10))
    assert.equal(existsSync(f.log),true,'known running detector')
    controller.abort();await rejected
    const saved=JSON.parse(await readFile(f.log,'utf8'))
    assert.equal(existsSync(dirname(saved.file)),false)
  } finally { await rm(f.directory,{recursive:true,force:true}) }
})

test('missing detector cannot silently bypass the guard', async () => {
  const directory=await mkdtemp(join(tmpdir(),'terry-vad-missing-'))
  try { await assert.rejects(requireSpeech(Buffer.from('audio'),join(directory,'whisper-cli'),join(directory,'model'),new AbortController().signal), /Speech detection is unavailable/) }
  finally { await rm(directory,{recursive:true,force:true}) }
})
