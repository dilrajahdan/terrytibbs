const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');
const helper = path.resolve('build/terry-native');
app.setName('Terry Paste Test');
let window;
app.whenReady().then(() => {
  window = new BrowserWindow({ width: 860, height: 650, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  window.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><html><body style="font:18px system-ui;padding:30px"><h1>Terry paste test</h1><p>Local disposable controls. No messages can be sent.</p><label>Plain textarea<textarea id="plain" style="display:block;width:90%;height:70px"></textarea></label><label>Rich message composer<div id="rich" contenteditable="true" role="textbox" aria-label="Rich message composer" style="border:1px solid;padding:15px;min-height:45px"></div></label><label>Read-only field<input id="readonly" readonly value="Read only"></label><label>Password<input id="secure" type="password"></label><p><button id="inspect">Inspect selected control</button> <button id="paste">Test paste into selected control</button></p><pre id="result"></pre><script>const { ipcRenderer }=require('electron');let selected='plain';for(const id of ['plain','rich','readonly','secure'])document.getElementById(id).addEventListener('focus',()=>selected=id);for(const kind of ['inspect','paste'])document.getElementById(kind).onclick=async()=>{document.getElementById(selected).focus();document.getElementById('result').textContent=await ipcRenderer.invoke(kind);};</script></body></html>`));
});
ipcMain.handle('inspect', () => { app.focus({steal:true}); window.focus(); return new Promise(resolve => setTimeout(()=>execFile(helper,['frontmost'],{ timeout: 3000 },(err,out)=>resolve(out || String(err))),150)); });
ipcMain.handle('paste', () => { app.focus({steal:true}); window.focus(); clipboard.writeText('Terry paste check.');return new Promise(resolve => execFile(process.execPath,['--import','tsx',path.resolve('scripts/paste-smoke-child.ts'),helper],{ timeout:15000,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'} },(err,out)=>resolve(out || String(err)))); });
app.on('window-all-closed',()=>app.quit());
