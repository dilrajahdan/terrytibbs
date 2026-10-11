import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('native function key recorder and watcher handle F13–F15 and Fn without posting OS events', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'terry-native-test-'))
  try {
    const source = readFileSync('native/terry.swift', 'utf8').split('let action = CommandLine.arguments')[0]
    const harness = `
func key(_ code: CGKeyCode, _ type: CGEventType, _ flags: CGEventFlags = []) -> CGEvent {
    let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: type == .keyDown)!
    event.type = type
    event.flags = flags
    return event
}
assert(physicalModifierFlags(isDown: { _ in false }).isEmpty)
assert(physicalModifierFlags(isDown: { $0 == 54 }) == .maskCommand)
assert(physicalModifierFlags(isDown: { $0 == 59 || $0 == 60 }) == [.maskControl, .maskShift])
assert(physicalModifierFlags(isDown: { $0 == 63 }).isEmpty)
let watcher = HotkeyWatcher(shortcut: parseShortcut("LeftControl")!)
watcher.setSuspended(true)
for code: CGKeyCode in [105, 107, 113] {
    assert(watcher.handle(type: .keyDown, event: key(code, .keyDown, .maskSecondaryFn)) == nil)
    assert(watcher.handle(type: .keyUp, event: key(code, .keyUp)) == nil)
}
_ = watcher.handle(type: .keyDown, event: key(105, .keyDown, [.maskControl, .maskSecondaryFn]))
_ = watcher.handle(type: .flagsChanged, event: key(63, .flagsChanged, .maskSecondaryFn))
_ = watcher.handle(type: .flagsChanged, event: key(63, .flagsChanged))
// Fn plus an F key must yield one F-key candidate, not a second Fn candidate.
_ = watcher.handle(type: .flagsChanged, event: key(63, .flagsChanged, .maskSecondaryFn))
_ = watcher.handle(type: .keyDown, event: key(107, .keyDown, .maskSecondaryFn))
_ = watcher.handle(type: .flagsChanged, event: key(63, .flagsChanged))
watcher.setSuspended(false)
assert(watcher.handle(type: .keyDown, event: key(105, .keyDown)) != nil)
for name in ["F13", "F14", "F15"] {
    let saved = HotkeyWatcher(shortcut: parseShortcut(name)!)
    let code = regularKeyCodes[name]!
    assert(saved.handle(type: .keyDown, event: key(code, .keyDown, .maskSecondaryFn)) == nil)
    assert(saved.active)
    assert(saved.handle(type: .keyUp, event: key(code, .keyUp)) == nil)
    assert(!saved.active)
}
let fn = HotkeyWatcher(shortcut: parseShortcut("Fn")!)
_ = fn.handle(type: .flagsChanged, event: key(63, .flagsChanged, .maskSecondaryFn))
assert(fn.active)
_ = fn.handle(type: .flagsChanged, event: key(63, .flagsChanged))
assert(!fn.active)
`
    writeFileSync(join(dir, 'main.swift'), source + harness)
    execFileSync('/usr/bin/swiftc', [join(dir, 'main.swift'), '-o', join(dir, 'test')])
    const events = execFileSync(join(dir, 'test'), { encoding: 'utf8' }).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(events.filter(e => e.type === 'candidate').map(e => e.shortcut), ['F13', 'F14', 'F15', 'Control+F13', 'Fn', 'F14'])
    assert.equal(events.filter(e => e.type === 'down').length, 4)
    assert.equal(events.filter(e => e.type === 'up').length, 4)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
