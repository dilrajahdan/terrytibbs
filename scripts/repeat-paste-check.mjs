// Manual macOS integration check. Requires Accessibility for Electron.
// Only the production paste path posts events, into this disposable local window.
import { _electron as electron } from '@playwright/test'
import assert from 'node:assert/strict'
const app = await electron.launch({ args: ['scripts/paste-smoke.cjs'] })
const originalClipboard = await app.evaluate(({clipboard})=>clipboard.readText())
try {
 const page = await app.firstWindow()
 await page.waitForLoadState('domcontentloaded')
 await app.evaluate(({app,BrowserWindow})=>{ app.focus({steal:true}); BrowserWindow.getAllWindows()[0].show(); BrowserWindow.getAllWindows()[0].focus() })
 for(const field of ['plain','rich','readonly','secure']) {
  await page.locator(`#${field}`).click()
  await page.locator('#result').evaluate(el=>el.textContent='')
  await page.locator('#inspect').click()
  await page.waitForFunction(()=>document.querySelector('#result').textContent.includes('editable'))
  const control=JSON.parse(await page.locator('#result').innerText())
  assert.equal(control.pid,app.process().pid)
  if(field==='plain'||field==='rich') assert.equal(control.editable,true)
  await page.locator('#result').evaluate(el=>el.textContent='')
  await page.locator('#paste').click()
  await page.waitForFunction(()=>document.querySelector('#result').textContent.length>0)
  const output=await page.locator('#result').innerText()
  assert(output.startsWith('['), output)
  const results=JSON.parse(output)
  const text=field==='rich'?await page.locator('#rich').innerText():await page.locator(`#${field}`).inputValue()
  console.log(JSON.stringify({field,results,text}))
  assert.equal(results.length,3)
  if(field==='plain'||field==='rich') {
   assert(results.every(r=>r.status==='sent'))
   assert.equal(text.trim(),'Terry paste check.'.repeat(3))
  } else {
   assert(results.every(r=>r.status==='clipboard'))
   assert.equal(text,field==='readonly'?'Read only':'')
  }
 }
} finally {
 await app.evaluate(({clipboard},original)=>{if(clipboard.readText()==='Terry paste check.')clipboard.writeText(original)},originalClipboard)
 await app.close()
}
