// Tutorial production only. Never called by the dictation app.
import fs from 'node:fs';  import {createHash} from 'node:crypto';
const key=process.env.ELEVENLABS_API_KEY;
if(!key || key.length<20)throw Error('ElevenLabs key missing');
fs.mkdirSync('artifacts/tutorial',{recursive:true});
const headers={'xi-api-key':key,'Content-Type':'application/json'};
const quota=await fetch('https://api.elevenlabs.io/v1/user/subscription',{headers}); if(!quota.ok)throw Error('Quota check failed: '+quota.status);
const q=await quota.json(); console.log('Narration quota available:',q.character_limit-q.character_count);
const story=JSON.parse(fs.readFileSync('scripts/tutorial/story.json'));
story.push({id:'sample',text:'Remember to buy coffee and book the train tickets for Friday.'});
for(const s of story){ const body={text:s.text,model_id:'eleven_multilingual_v2',voice_settings:{stability:.58,similarity_boost:.75,style:.08,use_speaker_boost:true}};
const hash=createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0,12); const cache=`artifacts/tutorial/${s.id}-${hash}.mp3`;
if(!fs.existsSync(cache)){const r=await fetch('https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128',{method:'POST',headers,body:JSON.stringify(body)});if(!r.ok)throw Error('Voice generation '+r.status);fs.writeFileSync(cache,Buffer.from(await r.arrayBuffer()));}
fs.copyFileSync(cache,`artifacts/tutorial/${s.id}.mp3`);console.log(s.id+' ready'); }
