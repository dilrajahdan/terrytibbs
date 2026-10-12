// Real native delivery to an owned editor. Never logs the user's clipboard.
import { _electron as electron, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
const fixture=spawn(resolve('artifacts/clipboard-fixture'),[],{stdio:['pipe','pipe','inherit']})
const lines=createInterface({input:fixture.stdout})[Symbol.asyncIterator]()
const receive=async()=>JSON.parse((await lines.next()).value)
const command=async(text)=>{fixture.stdin.write(text+'\n');return receive()}
if(!(await receive()).ready)throw Error('Clipboard fixture unavailable')
const dir=await mkdtemp('/tmp/terry-clipboard-editor-')
let app
try{
 app=await electron.launch({args:['scripts/tutorial/demo-editor.cjs'],env:{...process.env,TERRY_EDITOR_DATA:dir}})
 const page=await app.firstWindow();await page.waitForLoadState('domcontentloaded')
 const field=page.getByRole('textbox',{name:'Note'})
 await app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows()[0].focus()})
 for(const kind of ['rich','image','empty','rich','new','same']){
  await field.fill('');await field.click();await command(kind==='new'||kind==='same'?'rich':kind)
  if(!(await command('check')).matches)throw Error('Seed control failed');
  const text='A real preserved-clipboard paste.'
  const helper=spawn(resolve('build/terry-native'),['paste-preserving',String(app.process().pid)],{stdio:['pipe','pipe','pipe']})
  const done=new Promise((res,rej)=>{let output='';helper.stdout.on('data',d=>output+=d);helper.on('error',rej);helper.on('close',()=>{try{res(JSON.parse(output))}catch(e){rej(e)}})})
  helper.stdin.end(text)
  // Seeing real insertion is the control that the destination consumed the paste.
  await expect(field).toHaveValue(text)
  if(kind==='new'||kind==='same')await command(kind)
  const result=await done
  if(!result.ok)throw Error(JSON.stringify(result))
  const check=await command('check');if(!check.matches)throw Error('Clipboard changed unexpectedly: '+kind+' '+JSON.stringify({result,check}))
  console.log(kind+': insertion and full clipboard preservation passed')
 }
}finally{
 const restored=await command('restore');if(!restored.restored)throw Error('Could not restore original clipboard')
 fixture.stdin.end();if(app)await app.close();await rm(dir,{recursive:true,force:true})
}
