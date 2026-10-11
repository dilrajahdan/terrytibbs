"""Render the short tutorial from capture-short.mjs and reviewed local opener audio."""
import json,subprocess,textwrap
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
r=Path('artifacts/short');font='/System/Library/Fonts/Supplemental/Arial.ttf';bold='/System/Library/Fonts/Supplemental/Arial Bold.ttf'
def run(a):subprocess.run(a,check=True,stdout=subprocess.DEVNULL)
def f(size,heavy=False):return ImageFont.truetype(bold if heavy else font,size)
frames=json.loads((r/'frames.json').read_text());marks=json.loads((r/'capture-evidence.json').read_text())['marks']
(r/'frames.txt').write_text(''.join(f"file '{x['name']}'\nduration {frames[i+1]['at']-x['at'] if i+1<len(frames) else .1}\n" for i,x in enumerate(frames)))
run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',str(r/'frames.txt'),'-r','25','-c:v','libx264','-preset','fast','-crf','20',str(r/'raw.mp4')])
story=json.loads(Path('scripts/tutorial/short-story.json').read_text());lengths=[3.5,5.5,5.5,3.5];timeline=[];total=.9
# Opener and final call-to-action are graphic cards, not fabricated product screens.
def card(title,subtitle,filename):
 im=Image.new('RGB',(1280,900),'#191a17');d=ImageDraw.Draw(im);d.text((80,75),'TERRY TIBBS',font=f(26,True),fill='#ffda00');
 for i,line in enumerate(title.split('\n')):d.text((80,235+i*100),line,font=f(76,True),fill='#ffda00')
 for i,line in enumerate(subtitle.split('\n')):d.text((80,570+i*48),line,font=f(30),fill='white')
 im.save(r/filename)
card('Talk to me.','Your voice. Your words. Your Mac.','opener.png')
card('Open source.\nInstall it now.','github.com/DilrajAhdan/terrytibbs\nMac source install • Setup instructions in the README','install.png')
run(['ffmpeg','-v','error','-y','-loop','1','-i',str(r/'opener.png'),'-i',str(r/'opener.wav'),'-af','apad,loudnorm=I=-16:TP=-1.5:LRA=11','-t','0.9','-r','25','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-ar','48000',str(r/'opener.mp4')])
for i,s in enumerate(story):
 length=lengths[i];timeline.append({'id':s['id'],'start':total,'duration':length});total+=length
 start=marks[i]['at'];end=marks[i+1]['at'] if i+1<len(marks) else start+length;take=max(.3,end-start-.08)
 inputs=['ffmpeg','-v','error','-y']
 if s['id']=='install':inputs+=['-loop','1','-i',str(r/'install.png')]
 else:inputs+=['-ss',str(start),'-t',str(take),'-i',str(r/'raw.mp4')]
 inputs+=['-i',str(r/(s['id']+'.mp3'))]
 if s['id']!='install':
  im=Image.new('RGBA',(1280,900),'#191a17');d=ImageDraw.Draw(im);d.text((35,24),s['title'],font=f(38,True),fill='#ffda00');im.paste((0,0,0,0),(80,100,1200,800));
  cap={'choose':'Record shortcut → Use shortcut → Save settings','dictate':'Hold to talk. Release to paste.','handsfree':'Double-tap → lock. Press once more → finish.'}[s['id']]
  d.text((640,823),cap,anchor='mt',font=f(30,True),fill='white');d.text((35,876),'Real local transcription • Prerecorded demo speech • Edited timing',font=f(13),fill='#ccc')
  if s['id']=='handsfree':
   hud=Image.open(r/'hud-lock.png').convert('RGBA');hud.thumbnail((224,72));im.alpha_composite(hud,(990,720));d.text((990,704),'Lock indicator (enlarged)',font=f(13),fill='#191a17')
  im.save(r/(s['id']+'-overlay.png'));inputs+=['-loop','1','-i',str(r/(s['id']+'-overlay.png'))]
  rate=min(1,length/take)
  prefix=f'[0:v]setpts={rate}*PTS[edited];'
  if s['id'] in ['dictate','handsfree']: prefix=f'[0:v]split=2[a0][b0];[a0]trim=duration=1.5,setpts=PTS-STARTPTS[a1];[b0]trim=start={max(1.5,take-2.5)},setpts=PTS-STARTPTS[b1];[a1][b1]concat=n=2:v=1:a=0[edited];'
  filters=prefix+f'[edited]scale=1120:700,pad=1280:900:80:100:color=0x191a17,tpad=stop_mode=clone:stop_duration={length},setsar=1[v];[v][2:v]overlay=0:0[out];[1:a]apad,loudnorm=I=-16:TP=-1.5:LRA=11[a]'
 else:filters='[0:v]setsar=1[out];[1:a]apad,loudnorm=I=-16:TP=-1.5:LRA=11[a]'
 run(inputs+['-filter_complex',filters,'-map','[out]','-map','[a]','-t',str(length),'-r','25','-c:v','libx264','-preset','fast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-ar','48000',str(r/(s['id']+'.mp4'))])
(r/'concat.txt').write_text("file 'opener.mp4'\n"+''.join(f"file '{s['id']}.mp4'\n" for s in story))
run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',str(r/'concat.txt'),'-c','copy','-movflags','+faststart',str(r/'terry-tibbs-short.mp4')])
(r/'timeline.json').write_text(json.dumps(timeline,indent=2));print('Duration:',total)
