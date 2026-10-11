import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This initial release supports Apple Silicon Macs.')
const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(existsSync)
const engine = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'].find(existsSync)
if (!engine) {
  if (!brew) throw new Error('Install Homebrew from https://brew.sh, then run npm run setup again.')
  execFileSync(brew, ['install', 'whisper.cpp'], { stdio: 'inherit' })
}
const installedEngine = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'].find(existsSync)
if (!installedEngine || !existsSync(join(dirname(installedEngine), 'whisper-vad-speech-segments'))) throw new Error('The speech detector is missing. Run brew upgrade whisper.cpp, then npm run setup again.')
execFileSync(process.execPath, ['scripts/build-helper.mjs'], { stdio: 'inherit' })
const userData = join(homedir(), 'Library', 'Application Support', 'Terry Tibbs')
mkdirSync(userData, { recursive: true, mode: 0o700 })
// Use the same pinned source and checksum as the in-app download.
const { downloadModelFile, verifyDefaultModel, MODEL_NAME } = await import('../src/main/model.ts')
const model = join(userData, 'models', MODEL_NAME)
if (await verifyDefaultModel(model)) console.log('Whisper Turbo is already downloaded and verified.')
else {
  console.log('Downloading Whisper Turbo (1.62 GB). Speech runs offline after setup.')
  await downloadModelFile(model, percent => process.stdout.write(`\rDownload ${percent}%   `))
  console.log('\nModel verified.')
}
console.log('Setup complete. Run npm run dev, or npm run package for the macOS app.')
