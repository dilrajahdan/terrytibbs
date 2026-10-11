import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings, loadSettings, persistSettings, validateSettings } from '../src/main/settings'

test('settings round-trip and restrict stored fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'terry-settings-'))
  try {
    const settings = { ...defaultSettings(dir), vocabulary: 'Alex, TypeScript', shortcut: 'Control+Shift+D' }
    persistSettings(dir, settings)
    assert.deepEqual(loadSettings(dir), settings)
    assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8').includes('transcript'), false)
    assert.deepEqual(validateSettings({ ...settings, unexpected: 'ignored' }), settings)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('reject unsafe settings and shortcuts before changing registrations', () => {
  const settings = defaultSettings('/tmp/terry-test')
  assert.equal(validateSettings({ ...settings, shortcut: 'Globe' }).shortcut, 'Fn')
  for (const patch of [
    { whisperPath: 'whisper-cli' }, { modelPath: '/tmp/model\0.bin' }, { shortcut: 'A' },
    { shortcut: 'Escape' }, { shortcut: 'Alt+Space; open mail' }, { language: 'shell' },
    { vocabulary: 'x'.repeat(1001) }, { autoPaste: 'true' }, { muteOtherAudio: 'true' }, { keepMicrophoneReady: 'true' },
    { activationSound: 'unknown' }, { activationSound: 'clips', activationSoundDirectory: '' }, { activationSoundDirectory: '../sounds' },
    { activationSoundClip: '../hello.mp3' }, { activationSoundClip: '/tmp/hello.mp3' }, { activationSoundClip: '..' }, { activationSoundClip: 'x\\hello.mp3' }, { microphoneId: 3 }, { microphoneLabel: 'bad\0label' },
    { cleanupEnabled: true, cleanupModel: '' }, { cleanupModel: 'kimi:cloud' }
  ]) assert.throws(() => validateSettings({ ...settings, ...patch }))
})

test('existing preferences migrate to default input and rotation, selected input and clip persist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'terry-mic-settings-'))
  try {
    const old = { ...defaultSettings(dir), shortcut: 'F13', activationSound: 'clips', activationSoundDirectory: '/tmp/voice clips' } as Record<string, unknown>
    delete old.microphoneId; delete old.microphoneLabel; delete old.activationSoundClip
    const migrated = validateSettings(old)
    assert.equal(migrated.microphoneId, '')
    assert.equal(migrated.microphoneLabel, '')
    assert.equal(migrated.activationSoundClip, '')
    assert.equal(migrated.shortcut, 'F13')
    const selected = { ...migrated, microphoneId: 'exact-microphone-id', microphoneLabel: 'Yeti Stereo Microphone', activationSoundClip: '01 Hello.mp3' }
    persistSettings(dir, selected)
    assert.deepEqual(loadSettings(dir), selected)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('older settings retain silent activation defaults', () => {
  const settings = { ...defaultSettings('/tmp/terry') } as Record<string, unknown>
  delete settings.activationSound; delete settings.activationSoundDirectory
  const migrated = validateSettings(settings)
  assert.equal(migrated.activationSound, 'off')
  assert.equal(migrated.activationSoundDirectory, '')
})

 test('existing settings enable background muting, and an explicit off choice persists', () => {
  const old = { ...defaultSettings('/tmp/terry') } as Record<string, unknown>
  delete old.muteOtherAudio
  assert.equal(validateSettings(old).muteOtherAudio, true)
  assert.equal(validateSettings({ ...old, muteOtherAudio: false }).muteOtherAudio, false)
})

test('idle microphone remains opt-in and quick buzz is a persistent selection', () => {
  const old = { ...defaultSettings('/tmp/terry') } as Record<string, unknown>
  delete old.keepMicrophoneReady
  assert.equal(validateSettings(old).keepMicrophoneReady, false)
  const chosen = validateSettings({ ...old, keepMicrophoneReady: true, activationSound: 'buzz' })
  assert.equal(chosen.keepMicrophoneReady, true)
  assert.equal(chosen.activationSound, 'buzz')
})
