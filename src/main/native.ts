import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export interface FrontApp { pid: number; name: string; bundleId: string; trusted: boolean; editable: boolean; focus?: string }
export interface PasteResult { status: 'sent' | 'clipboard'; message: string; reason?: string }
export async function frontmost(helper: string, signal?: AbortSignal): Promise<FrontApp> {
  const { stdout } = await execute(helper, ['frontmost'], { timeout: 3000, signal })
  return JSON.parse(stdout) as FrontApp
}

export async function requestAccessibility(helper: string): Promise<void> {
  await execute(helper, ['request-accessibility'], { timeout: 3000 })
}

function copiedOnly(reason: string): PasteResult {
  const explanation: Record<string, string> = {
    no_target: 'Start dictation with the cursor in your destination app.',
    focus_changed: 'Your active app changed. Press Command+V to paste.',
    non_editable: 'The focused control was not recognised as editable. Press Command+V to paste.',
    secure_field: 'Automatic paste is disabled in password fields.',
    accessibility: 'Allow Accessibility in Terry Settings to paste automatically.',
    modifiers_held: 'Another modifier key was still held. Press Command+V to paste.',
    event_failed: 'macOS could not send the paste shortcut. Press Command+V to paste.',
    unavailable: 'Automatic paste was unavailable. Press Command+V to paste.'
  }
  return { status: 'clipboard', reason, message: `Copied only. ${explanation[reason] || explanation.unavailable}` }
}

export async function pasteTranscript(helper: string, _text: string, target: FrontApp | null, signal?: AbortSignal): Promise<PasteResult> {
  signal?.throwIfAborted()
  if (!target || target.pid === process.pid || target.bundleId.startsWith('dev.terrytibbs')) return copiedOnly('no_target')
  if (target.focus === 'secure') return copiedOnly('secure_field')
  // A first AX query can precede Chromium's accessibility tree. Do not permanently
  // reject that stale snapshot: the helper rechecks the actual focus before posting.
  let stdout = ''
  try {
    stdout = (await execute(helper, ['paste', String(target.pid)], { timeout: 3000, signal })).stdout
  } catch (error) {
    signal?.throwIfAborted()
    stdout = typeof (error as { stdout?: unknown }).stdout === 'string' ? (error as { stdout: string }).stdout : ''
  }
  signal?.throwIfAborted()
  try {
    const result = JSON.parse(stdout)
    if (result.ok === true) return { status: 'sent', message: `Paste sent to ${target.name}. Transcript is also on the clipboard.` }
    return copiedOnly(typeof result.reason === 'string' ? result.reason : 'unavailable')
  } catch { return copiedOnly('unavailable') }
}
