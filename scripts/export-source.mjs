// Export a reviewed source snapshot, never the private development Git history.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
const publicDocs = new Set(['INSTALL.md','MODELS-AND-HARDWARE.md','BENCHMARKS.md','USER-GUIDE.md','RELEASE.md','WHISPER-SERVER-NOTES.md'])
const topLevel = new Set(['.gitignore','CONTRIBUTING.md','LICENSE','README.md','SECURITY.md','THIRD_PARTY_NOTICES.md','package.json','package-lock.json','tsconfig.json','electron.vite.config.ts','playwright.config.ts'])
const files = execFileSync('git', ['ls-tree','-r','--name-only','HEAD'], {encoding:'utf8'}).trim().split('\n').filter(file =>
 topLevel.has(file) || /^(src|native|tests|scripts|resources)\//.test(file) || file.startsWith('.github/workflows/') || file === 'build/entitlements.mac.plist' ||
 file.startsWith('docs/data/') || file.startsWith('docs/images/') || (file.startsWith('docs/') && publicDocs.has(file.slice(5))))
const privateTerms = (process.env.TERRY_PRIVATE_TERMS || '').split('|').filter(Boolean)
const temporary = mkdtempSync(join(tmpdir(), 'terry-public-'))
const root = join(temporary, 'terrytibbs')
try {
 for (const file of files) {
  if (/(^|\/)(\.env[^/]*|settings\.json)$|\.(wav|aiff|bin|log)$/i.test(file)) throw new Error(`Private/runtime file selected: ${file}`)
  const bytes = execFileSync('git',['show',`HEAD:${file}`], {maxBuffer: 20*1024*1024})
  const text = bytes.toString('utf8')
  const privateHome = new RegExp('/' + 'Users/[^/\\s]+/|' + '/' + 'home/[^/\\s]+/')
  const credential = /-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{30,}/
  if (privateHome.test(text) || credential.test(text) || privateTerms.some(term=>text.toLowerCase().includes(term.toLowerCase()))) throw new Error(`Privacy review required: ${file}`)
  const destination=join(root,file); mkdirSync(dirname(destination),{recursive:true}); writeFileSync(destination,bytes)
 }
 mkdirSync('release',{recursive:true})
 const output=resolve('release/Terry-Tibbs-public-source.zip')
 execFileSync('/usr/bin/ditto',['-c','-k','--norsrc','--noextattr','--noqtn','--keepParent',root,output])
 console.log(`Exported ${files.length} committed files without Git history: ${output}`)
 console.log('Automated checks cover local home paths, selected credentials and supplied private terms. Manual content, images, licences and dependency review remain necessary.')
} finally { rmSync(temporary,{recursive:true,force:true}) }
