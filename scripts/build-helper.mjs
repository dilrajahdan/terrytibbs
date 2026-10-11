import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
if (process.platform !== 'darwin') throw new Error('Terry Tibbs currently builds on macOS only.')
mkdirSync('build', { recursive: true })
execFileSync('/usr/bin/swiftc', ['native/terry.swift', '-O', '-o', 'build/terry-native'], { stdio: 'inherit' })
execFileSync('/usr/bin/swiftc', ['native/audio-guard.swift', '-O', '-o', 'build/terry-audio'], { stdio: 'inherit' })

await import('./prepare-vad.mjs')
