import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCorrections, suggestCorrections, validateCorrections } from '../src/shared/corrections'
import { defaultSettings, validateSettings } from '../src/main/settings'

test('confirmed replacements match whole phrases, preserve punctuation and never cascade', () => {
  const rules = [{ from: 'terry tips', to: 'Terry Tibbs' }, { from: 'terry', to: 'Terry' }, { from: 'Terry Tibbs', to: 'Wrong cascade' }]
  assert.equal(applyCorrections('Ask TERRY TIPS, then terry. Not terrytips.', rules), 'Ask Terry Tibbs, then Terry. Not terrytips.')
  assert.equal(applyCorrections('Ann and annex; ann\'s notes.', [{ from: 'ann', to: 'Anne' }]), "Anne and annex; ann's notes.")
  assert.equal(applyCorrections('Use C++ today, not C++Builder.', [{ from: 'C++', to: 'C plus plus' }]), 'Use C plus plus today, not C++Builder.')
  assert.equal(applyCorrections('Visit new\n york.', [{ from: 'new york', to: 'New York' }]), 'Visit New York.')
  assert.equal(applyCorrections('hello', [{ from: 'hello', to: '$& local' }]), '$& local')
})

test('learning finds small word/name corrections without learning deletions or rewrites', () => {
  assert.deepEqual(suggestCorrections('Send this to Shunade at Example Studio.', 'Send this to Sinead at Example Studio.'), [{ from: 'Shunade', to: 'Sinead' }])
  assert.deepEqual(suggestCorrections('Open github and ask terry tips for help.', 'Open GitHub and ask Terry Tibbs for help.'), [{ from: 'github', to: 'GitHub' }, { from: 'terry tips', to: 'Terry Tibbs' }])
  assert.deepEqual(suggestCorrections('Please send the note.', 'Please send the note!'), [])
  assert.deepEqual(suggestCorrections('Please um send the note.', 'Please send the note.'), [])
  assert.deepEqual(suggestCorrections('Please send the note.', 'Please quickly send the note.'), [])
  assert.deepEqual(suggestCorrections('Send the first note to our team.', 'Actually cancel everything and call me tomorrow.'), [])
  assert.deepEqual(suggestCorrections('Shunade', 'Sinead'), [{ from: 'Shunade', to: 'Sinead' }])
  assert.deepEqual(suggestCorrections('word '.repeat(600), 'term '.repeat(600)), [])
})

test('settings migrate locally and validate correction limits and duplicates', () => {
  const defaults = defaultSettings('/tmp/terry-corrections-test')
  assert.deepEqual(defaults.corrections, [])
  const old = { ...defaults } as Record<string, unknown>
  delete old.corrections; delete old.correctionsEnabled
  assert.deepEqual(validateSettings(old).corrections, [])
  assert.equal(validateSettings(old).correctionsEnabled, true)
  assert.deepEqual(validateCorrections([{ from: '  terry  tips ', to: ' Terry Tibbs ' }]), [{ from: 'terry tips', to: 'Terry Tibbs' }])
  assert.throws(() => validateCorrections([{ from: '', to: 'A' }]))
  assert.throws(() => validateCorrections([{ from: 'A', to: 'A' }]))
  assert.throws(() => validateCorrections([{ from: 'A\nB', to: 'C' }]))
  assert.throws(() => validateCorrections([{ from: 'a', to: 'B' }, { from: 'A', to: 'C' }]))
  assert.throws(() => validateCorrections(Array.from({ length: 201 }, (_, i) => ({ from: `word${i}`, to: 'replacement' }))))
})
