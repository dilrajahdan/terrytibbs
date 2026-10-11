"""Compose narrated real-app footage. Requires ffmpeg, ffprobe and Pillow.
Run after capture.mjs. Speech clips live in ignored artifacts/tutorial.
"""
import json, subprocess, textwrap
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
root=Path('artifacts/tutorial'); story=json.loads(Path('scripts/tutorial/story.json').read_text())
font='/System/Library/Fonts/Supplemental/Arial.ttf'
bold='/System/Library/Fonts/Supplemental/Arial Bold.ttf'
def run(args): subprocess.run(args,check=True,stdout=subprocess.DEVNULL)
def duration(p): return float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',str(p)]))
frames=json.loads((root/'frames.json').read_text())
(root/'frames.txt').write_text(''.join(f"file '{f['name']}'\nduration {frames[i+1]['at']-f['at'] if i+1<len(frames) else .1}\n" for i,f in enumerate(frames)))
if not (root/'walkthrough.webm').exists(): run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',str(root/'frames.txt'),'-r','25','-c:v','libvpx-vp9','-b:v','0','-crf','28',str(root/'walkthrough.webm')])
marks=json.loads((root/'capture-evidence.json').read_text())['marks']; total=0; subtitles=[]; timeline=[]
def stamp(t):
 ms=round(t*1000); return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'
for i,s in enumerate(story):
 voice=duration(root/(s['id']+'.mp3')); length=voice+1.0
 # Cut on the verified screenshots. Recording startup is conservatively offset by 0.3s.
 start=max(0,marks[i]['at']); end=marks[i+1]['at'] if i+1<len(marks) else duration(root/'walkthrough.webm')
 take=max(.3,min(end-start-.12,length))
 # A graphic frame surrounds footage, never replaces the product UI.
 layer=Image.new('RGBA',(1280,960),(24,25,22,255));d=ImageDraw.Draw(layer)
 d.text((34,22),s['title'],font=ImageFont.truetype(bold,36),fill='#FFDA00')
 d.text((35,69),'TERRY TIBBS  /  QUICK START',font=ImageFont.truetype(font,16),fill='#FFFFFF')
 layer.paste((0,0,0,0),(0,110,1280,910))
 d.text((35,927),'Real app • Prerecorded demo speech • Edited pauses',font=ImageFont.truetype(font,16),fill='#FFFFFF')
 overlay=root/(s['id']+'-frame.png');layer.save(overlay)
 # Burn readable short caption groups, timed within each voice line.
 words=s['text'].split(); chunks=[' '.join(words[n:n+11]) for n in range(0,len(words),11)]
 captions=[]
 for j,c in enumerate(chunks):
  a=voice*j/len(chunks);b=voice*(j+1)/len(chunks)
  sub=Image.new('RGBA',(1280,960));sd=ImageDraw.Draw(sub);lines=textwrap.wrap(c,65)
  sd.rectangle((0,806,1280,906),fill=(20,21,18,255))
  for k,line in enumerate(lines):sd.text((640,818+k*36),line,anchor='mt',font=ImageFont.truetype(bold,27),fill='white')
  p=root/f'{s["id"]}-caption-{j}.png';sub.save(p);captions.append((p,a,b))
  subtitles.append(f'{len(subtitles)+1}\n{stamp(total+a)} --> {stamp(total+b)}\n{c}\n')
 inputs=['ffmpeg','-v','error','-y','-ss',str(start),'-t',str(take),'-i',str(root/'walkthrough.webm'),'-i',str(root/(s['id']+'.mp3')),'-loop','1','-i',str(overlay)]
 if s['id']=='settings': inputs=['ffmpeg','-v','error','-y','-loop','1','-i',str(root/'settings.png'),'-i',str(root/'settings.mp3'),'-loop','1','-i',str(overlay)]
 for p,a,b in captions:inputs+=['-loop','1','-i',str(p)]
 f=f'[0:v]scale=1280:800,pad=1280:960:0:110:color=0x181916,tpad=stop_mode=clone:stop_duration={length},setsar=1[v0];[v0][2:v]overlay=0:0[v1];'
 previous='v1'
 for j,(p,a,b) in enumerate(captions):
  current=f'v{j+2}';f+=f'[{previous}][{j+3}:v]overlay=0:0:enable=\'between(t,{a},{b})\'[{current}];';previous=current
 f+='[1:a]apad,loudnorm=I=-16:TP=-1.5:LRA=11[a]'
 run(inputs+['-filter_complex',f,'-map',f'[{previous}]','-map','[a]','-t',str(length),'-r','25','-c:v','libx264','-preset','fast','-crf','24','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k',str(root/(s['id']+'.mp4'))])
 timeline.append({'id':s['id'],'start':round(total,3),'duration':round(length,3)});total+=length
(root/'concat.txt').write_text(''.join(f"file '{s['id']}.mp4'\n" for s in story))
Path('docs/tutorial-captions.srt').write_text('\n'.join(subtitles))
run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',str(root/'concat.txt'),'-c','copy','-movflags','+faststart',str(root/'terry-tibbs-tutorial.mp4')])
(root/'timeline.json').write_text(json.dumps(timeline,indent=2))
print('Rendered',round(total,1),'seconds')
