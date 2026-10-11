import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pasteTranscript, type FrontApp } from '../src/main/native'

// Exercise the actual subprocess/argv contract without posting into the desktop.
// The native helper owns the final focus/permission/field check, atomically with paste.
test('paste retries current focus instead of permanently rejecting a stale initial field check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terry-paste-'))
  const helper = join(dir, 'helper')
  const calls = join(dir, 'calls')
  const response = join(dir, 'response')
  writeFileSync(helper, `#!/bin/sh\nprintf '%s\\n' "$1 $2" >> '${calls}'\ncat '${response}'\n`)
  chmodSync(helper, 0o700)
  const target: FrontApp = { pid: 999, name: 'Rich editor', bundleId: 'dev.example.editor', trusted: true, editable: false }
  try {
    writeFileSync(response, '{"ok":true}')
    const result = await pasteTranscript(helper, 'hello', target)
    assert.equal(result.status, 'sent')
    assert.match(result.message, /Paste sent/)
    assert.equal(readFileSync(calls, 'utf8'), 'paste 999\n')
    rmSync(calls)
    for (const reason of ['focus_changed', 'non_editable', 'secure_field', 'accessibility', 'modifiers_held', 'event_failed']) {
      writeFileSync(response, JSON.stringify({ ok: false, reason }))
      const rejected = await pasteTranscript(helper, 'hello', target)
      assert.equal(rejected.status, 'clipboard')
      assert.equal(rejected.reason, reason)
      assert.match(rejected.message, /Copied only/)
    }
    rmSync(calls)
    assert.equal((await pasteTranscript(helper, 'hello', { ...target, pid: process.pid })).status, 'clipboard')
    assert.equal(existsSync(calls), false)
    const controller = new AbortController(); controller.abort()
    await assert.rejects(pasteTranscript(helper, 'hello', target, controller.signal), /abort/i)
    assert.equal(existsSync(calls), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('native failures and malformed responses never report paste success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terry-paste-error-'))
  const helper = join(dir, 'helper')
  const target: FrontApp = { pid: 999, name: 'Editor', bundleId: 'dev.example.editor', trusted: true, editable: true }
  try {
    for (const script of ["printf '{\"ok\":false,\"reason\":\"secure_field\"}'; exit 4", "printf 'not-json'", "exit 0"]) {
      writeFileSync(helper, '#!/bin/sh\n' + script + '\n'); chmodSync(helper, 0o700)
      assert.equal((await pasteTranscript(helper, 'hello', target)).status, 'clipboard')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
