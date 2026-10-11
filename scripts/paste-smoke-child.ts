import { frontmost, pasteTranscript } from '../src/main/native'

// Manual smoke test only. No content is read from the destination control.
async function run() {
  const helper = process.argv[2]
  const target = await frontmost(helper)
  if (target.bundleId !== 'com.github.Electron') throw new Error('Focus the disposable Electron test window first.')
  // Reproduce the stale-snapshot case while using the real final AX check and paste.
  const result = []
  for (let attempt = 0; attempt < 3; attempt++) result.push(await pasteTranscript(helper, '', { ...target, editable: false }))
  process.stdout.write(JSON.stringify(result))
}
void run().catch(error => { process.stderr.write(String(error)); process.exitCode = 1 })
