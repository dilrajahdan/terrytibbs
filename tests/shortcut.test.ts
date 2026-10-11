import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHotkeyMonitor, type HotkeyEvent } from '../src/main/hotkey'
import { formatShortcut, parseShortcut, shortcutFromKeyboardEvent } from '../src/shared/shortcut'

test('shortcut parser normalises aliases and preserves side-specific modifiers', () => {
  assert.deepEqual(parseShortcut('ctrl+alt+d'), { value: 'Control+Option+D', modifiers: ['Control', 'Option'], key: 'D' })
  assert.deepEqual(parseShortcut('RightOption+Space'), { value: 'RightOption+Space', modifiers: ['RightOption'], key: 'Space' })
  assert.deepEqual(parseShortcut('leftcontrol'), { value: 'LeftControl', modifiers: ['LeftControl'], key: null })
  assert.equal(parseShortcut('f20').value, 'F20')
  assert.equal(parseShortcut('Globe').value, 'Fn')
  assert.equal(formatShortcut('Fn'), 'Globe / Fn')
  assert.equal(formatShortcut('RightOption+Space'), 'Right Option + Space')
})

test('shortcut parser rejects unsafe, ambiguous and unmodified typing keys', () => {
  for (const value of ['A', '7', 'Space', 'Escape', 'F21', 'Option', 'LeftOption+Option+D', 'Control++D', '']) {
    assert.throws(() => parseShortcut(value), /Choose a modifier/)
  }
})

test('keyboard events become canonical shortcuts without accepting repeats', () => {
  assert.equal(shortcutFromKeyboardEvent({ key: 'd', code: 'KeyD', ctrlKey: true, shiftKey: true }), 'Control+Shift+D')
  assert.equal(shortcutFromKeyboardEvent({ key: ' ', code: 'Space', altKey: true, modifierCodes: ['AltRight'] }), 'RightOption+Space')
  assert.equal(shortcutFromKeyboardEvent({ key: 'Alt', code: 'AltRight', location: 2, altKey: true }), 'RightOption')
  assert.equal(shortcutFromKeyboardEvent({ key: 'F12', code: 'F12' }), 'F12')
  assert.equal(shortcutFromKeyboardEvent({ key: 'a', code: 'KeyA' }), null)
  assert.equal(shortcutFromKeyboardEvent({ key: 'd', code: 'KeyD', ctrlKey: true, repeat: true }), null)
  assert.equal(shortcutFromKeyboardEvent({ key: 'Escape', code: 'Escape', ctrlKey: true }), null)
})

test('hotkey monitor waits for native readiness, forwards events and stops cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terry-hotkey-'))
  const helper = join(dir, 'helper')
  writeFileSync(helper, '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"ready"}\' \'{"type":"down"}\' \'{"type":"up"}\'\nwhile IFS= read -r line; do :; done\n')
  chmodSync(helper, 0o700)
  const events: HotkeyEvent[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('monitor events timed out')), 2_000)
      const monitor = createHotkeyMonitor(helper, 'RightOption+Space', event => {
        events.push(event)
        if (event.type === 'up') {
          monitor.suspend(true)
          monitor.stop()
          clearTimeout(timeout)
          resolve()
        }
      })
    })
    assert.deepEqual(events.map(event => event.type), ['ready', 'down', 'up'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('hotkey monitor never reports ready when the helper exits first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terry-hotkey-'))
  const helper = join(dir, 'helper')
  writeFileSync(helper, '#!/bin/sh\nexit 2\n')
  chmodSync(helper, 0o700)
  const events: HotkeyEvent[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('monitor exit timed out')), 2_000)
      createHotkeyMonitor(helper, 'F12', event => {
        events.push(event)
        if (event.type === 'unavailable') { clearTimeout(timeout); resolve() }
      })
    })
    assert.deepEqual(events.map(event => event.type), ['unavailable'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('hotkey monitor cancels an active consumer when a ready helper disconnects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terry-hotkey-'))
  const helper = join(dir, 'helper')
  writeFileSync(helper, '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"ready"}\'\nexit 3\n')
  chmodSync(helper, 0o700)
  const events: HotkeyEvent[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('monitor disconnect timed out')), 2_000)
      createHotkeyMonitor(helper, 'F12', event => {
        events.push(event)
        if (event.type === 'unavailable') { clearTimeout(timeout); resolve() }
      })
    })
    assert.deepEqual(events.map(event => event.type), ['ready', 'cancel', 'unavailable'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('hotkey suspension waits for acknowledgements and serialises rapid state changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terry-hotkey-'))
  const helper = join(dir, 'helper')
  writeFileSync(helper, `#!/bin/sh
printf '%s\\n' '{"type":"ready"}'
while IFS= read -r line; do
  sleep 0.08
  case "$line" in
    *true*) printf '%s\\n' '{"type":"suspended","paused":true}' ;;
    *false*) printf '%s\\n' '{"type":"suspended","paused":false}' ;;
  esac
done
`)
  chmodSync(helper, 0o700)
  const holder: { monitor?: ReturnType<typeof createHotkeyMonitor> } = {}
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('monitor readiness timed out')), 2_000)
      holder.monitor = createHotkeyMonitor(helper, 'F12', event => {
        if (event.type === 'ready') { clearTimeout(timeout); resolve() }
      })
    })
    const monitor = holder.monitor
    assert.ok(monitor)
    let sameStateResolved = 0
    const first = monitor.suspend(true).then(() => { sameStateResolved++ })
    const repeated = monitor.suspend(true).then(() => { sameStateResolved++ })
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(sameStateResolved, 0)
    await Promise.all([first, repeated])
    assert.equal(sameStateResolved, 2)

    let noopResolved = false
    const noop = monitor.suspend(true).then(() => { noopResolved = true })
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(noopResolved, false)
    await noop

    const order: string[] = []
    const resume = monitor.suspend(false).then(() => { order.push('resumed') })
    const pauseAgain = monitor.suspend(true).then(() => { order.push('suspended') })
    await Promise.all([resume, pauseAgain])
    assert.deepEqual(order, ['resumed', 'suspended'])
  } finally {
    holder.monitor?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hotkey suspension resolves safely when the helper input closes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terry-hotkey-'))
  const helper = join(dir, 'helper')
  writeFileSync(helper, '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"ready"}\'\nexec 0<&-\nsleep 0.2\n')
  chmodSync(helper, 0o700)
  const holder: { monitor?: ReturnType<typeof createHotkeyMonitor> } = {}
  try {
    let unavailable!: Promise<void>
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('monitor readiness timed out')), 2_000)
      let unavailableResolve!: () => void
      unavailable = new Promise(done => { unavailableResolve = done })
      holder.monitor = createHotkeyMonitor(helper, 'F12', event => {
        if (event.type === 'ready') { clearTimeout(timeout); resolve() }
        if (event.type === 'unavailable') unavailableResolve()
      })
    })
    const monitor = holder.monitor
    assert.ok(monitor)
    await monitor.suspend(true)
    await unavailable
  } finally {
    holder.monitor?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hotkey suspension fails closed when acknowledgement times out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terry-hotkey-'))
  const helper = join(dir, 'helper')
  writeFileSync(helper, '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"ready"}\'\nwhile IFS= read -r line; do :; done\n')
  chmodSync(helper, 0o700)
  const holder: { monitor?: ReturnType<typeof createHotkeyMonitor> } = {}
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('monitor readiness timed out')), 2_000)
      holder.monitor = createHotkeyMonitor(helper, 'F12', event => {
        if (event.type === 'ready') { clearTimeout(timeout); resolve() }
      })
    })
    const monitor = holder.monitor
    assert.ok(monitor)
    const started = Date.now()
    await assert.rejects(monitor.suspend(true), /did not confirm/)
    assert.ok(Date.now() - started >= 1_400)
    assert.ok(Date.now() - started < 2_500)
  } finally {
    holder.monitor?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native candidates require an acknowledged recording session', async () => {
  for (const valid of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), 'terry-candidate-'))
    const helper = join(dir, 'helper')
    writeFileSync(helper, valid
      ? '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"ready"}\'\nread -r line\nprintf \'%s\\n\' \'{"type":"suspended","paused":true}\' \'{"type":"candidate","shortcut":"F13"}\'\nwhile IFS= read -r line; do :; done\n'
      : '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"ready"}\' \'{"type":"candidate","shortcut":"F13"}\'\nwhile IFS= read -r line; do :; done\n')
    chmodSync(helper, 0o700)
    let monitor: ReturnType<typeof createHotkeyMonitor> | undefined
    try {
      const event = await new Promise<HotkeyEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('candidate timeout')), 3000)
        monitor = createHotkeyMonitor(helper, 'F14', event => {
          if (event.type === 'ready' && valid) void monitor!.suspend(true).catch(reject)
          if (event.type === 'candidate' || event.type === 'unavailable') { clearTimeout(timer); resolve(event) }
        })
      })
      if (valid) assert.deepEqual(event, { type: 'candidate', shortcut: 'F13' })
      else { assert.equal(event.type, 'unavailable'); assert.match(event.message!, /outside recording/) }
    } finally { monitor?.stop(); rmSync(dir, { recursive: true, force: true }) }
  }
})
