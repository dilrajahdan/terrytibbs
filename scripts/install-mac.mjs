import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Use a native Apple Silicon Mac terminal.')
const major = Number(execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).split('.')[0])
if (major < 15) throw new Error('The supported Homebrew installation route requires macOS 15 or newer.')
execFileSync('/usr/bin/xcode-select', ['-p'], { stdio: 'inherit' })
const [nodeMajor,nodeMinor] = process.versions.node.split('.').map(Number)
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) throw new Error('Use Node.js 22.12 or newer.')
if (!existsSync('/opt/homebrew/bin/brew')) throw new Error('Install Homebrew from brew.sh first.')
const target = join(homedir(), 'Applications', 'Terry Tibbs.app')
// A first install must never overwrite a running app or an existing installation.
if (process.argv.includes('--check')) {
  console.log('Platform and developer tools checked. Install will download dependencies/model, build, then copy into ~/Applications. Existing apps are never overwritten.')
  process.exit(0)
}
if (existsSync(target)) throw new Error('Terry already exists in ~/Applications. Quit it and use the documented update process; this installer will not overwrite it.')
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run npm run install:mac from the source folder.')
execFileSync(process.execPath, [npm, 'ci'], { stdio: 'inherit' })
for (const task of ['setup', 'package']) execFileSync(process.execPath, [npm, 'run', task], { stdio: 'inherit' })
mkdirSync(join(homedir(), 'Applications'), { recursive: true })
execFileSync('/usr/bin/ditto', [resolve('release/mac-arm64/Terry Tibbs.app'), target], { stdio: 'inherit' })
execFileSync('/usr/bin/open', [target], { stdio: 'inherit' })
console.log('Installed in ~/Applications. Open the microphone menu, allow Microphone and Accessibility, then test a sentence in TextEdit. macOS permission prompts still need your clicks.')
