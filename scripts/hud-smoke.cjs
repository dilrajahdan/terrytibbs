// Local disposable target for a native mouse hit-test beneath the dictation pill.
// Run with: npx electron scripts/hud-smoke.cjs
const { app, BrowserWindow, screen } = require('electron');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const temporary = mkdtempSync(join(tmpdir(), 'terry-hud-pointer-'));
app.setPath('userData', temporary);
app.setName('Terry Pointer Check');
let window;
app.whenReady().then(() => {
  const area = screen.getPrimaryDisplay().workArea;
  window = new BrowserWindow({ title: 'Terry pointer check', x: Math.round(area.x + (area.width - 420) / 2), y: area.y + area.height - 220, width: 420, height: 212, frame: false, resizable: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><html><body style="margin:0;background:#fff;font:15px system-ui"><main style="padding:16px"><strong>Terry pointer check</strong><p>Double-tap F13 to show the pill, then click its centre. The button underneath should receive the click.</p><output id="result">Clicks received: 0</output><p>Escape cancels. Command + Q closes this test.</p></main><button id="probe" style="position:absolute;bottom:0;left:20px;right:20px;height:44px">Click through the pill</button><script>let clicks=0;document.getElementById('probe').onclick=()=>document.getElementById('result').textContent='Clicks received: '+(++clicks);</script></body></html>`));
});
app.on('window-all-closed', () => app.quit());
app.on('quit', () => rmSync(temporary, { recursive: true, force: true }));
