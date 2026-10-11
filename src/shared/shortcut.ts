export type ShortcutModifier =
  | 'Command' | 'LeftCommand' | 'RightCommand'
  | 'Control' | 'LeftControl' | 'RightControl'
  | 'Option' | 'LeftOption' | 'RightOption'
  | 'Shift' | 'LeftShift' | 'RightShift'
  | 'Fn'

export type ShortcutKey = string

export interface ParsedShortcut {
  value: string
  modifiers: ShortcutModifier[]
  key: ShortcutKey | null
}

export interface ShortcutKeyboardEvent {
  key: string
  code?: string
  location?: number
  repeat?: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  getModifierState?(key: string): boolean
  /** Modifier codes currently held, tracked by the shortcut picker across key events. */
  modifierCodes?: Iterable<string>
}

const modifierAliases = new Map<string, ShortcutModifier>([
  ['command', 'Command'], ['cmd', 'Command'], ['commandorcontrol', 'Command'], ['super', 'Command'],
  ['leftcommand', 'LeftCommand'], ['rightcommand', 'RightCommand'],
  ['control', 'Control'], ['ctrl', 'Control'], ['leftcontrol', 'LeftControl'], ['rightcontrol', 'RightControl'],
  ['option', 'Option'], ['alt', 'Option'], ['leftoption', 'LeftOption'], ['rightoption', 'RightOption'],
  ['shift', 'Shift'], ['leftshift', 'LeftShift'], ['rightshift', 'RightShift'], ['fn', 'Fn'], ['globe', 'Fn']
])

const family = (modifier: ShortcutModifier): string => modifier.replace(/^(Left|Right)/, '')
const modifierOrder = new Map([['Command', 0], ['Control', 1], ['Option', 2], ['Shift', 3], ['Fn', 4]])
const isSideSpecific = (modifier: ShortcutModifier) => modifier.startsWith('Left') || modifier.startsWith('Right') || modifier === 'Fn'

function normaliseKey(raw: string): ShortcutKey | null {
  if (raw === ' ') return 'Space'
  const token = raw.trim()
  if (/^[a-z]$/i.test(token)) return token.toUpperCase()
  if (/^[0-9]$/.test(token)) return token
  if (/^f(?:[1-9]|1\d|20)$/i.test(token)) return token.toUpperCase()
  if (/^(?:space|spacebar)$/i.test(token)) return 'Space'
  return null
}

function invalidShortcut(): never {
  throw new Error('Choose a modifier with a letter, number or Space, a function key, or a left/right modifier.')
}

export function parseShortcut(value: unknown): ParsedShortcut {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) return invalidShortcut()
  const parts = value.split('+').map(part => part.trim())
  if (parts.some(part => !part)) return invalidShortcut()

  const modifiers: ShortcutModifier[] = []
  let key: ShortcutKey | null = null
  for (const part of parts) {
    const modifier = modifierAliases.get(part.toLowerCase())
    if (modifier) {
      if (modifiers.some(existing => family(existing) === family(modifier))) return invalidShortcut()
      modifiers.push(modifier)
      continue
    }
    const nextKey = normaliseKey(part)
    if (!nextKey || key) return invalidShortcut()
    key = nextKey
  }

  if (key === 'Escape' || (!modifiers.length && (!key || !/^F(?:[1-9]|1\d|20)$/.test(key)))) return invalidShortcut()
  if (!key && !modifiers.some(isSideSpecific)) return invalidShortcut()
  modifiers.sort((a, b) => (modifierOrder.get(family(a)) ?? 99) - (modifierOrder.get(family(b)) ?? 99))
  return { value: [...modifiers, ...(key ? [key] : [])].join('+'), modifiers, key }
}

const codeModifiers = new Map<string, ShortcutModifier>([
  ['MetaLeft', 'LeftCommand'], ['OSLeft', 'LeftCommand'], ['MetaRight', 'RightCommand'], ['OSRight', 'RightCommand'],
  ['ControlLeft', 'LeftControl'], ['ControlRight', 'RightControl'],
  ['AltLeft', 'LeftOption'], ['AltRight', 'RightOption'],
  ['ShiftLeft', 'LeftShift'], ['ShiftRight', 'RightShift'], ['Fn', 'Fn']
])

function modifierForEvent(event: ShortcutKeyboardEvent): ShortcutModifier | null {
  const fromCode = event.code ? codeModifiers.get(event.code) : undefined
  if (fromCode) return fromCode
  const location = event.location === 2 ? 'Right' : event.location === 1 ? 'Left' : ''
  if (event.key === 'Meta' || event.key === 'OS') return `${location}Command` as ShortcutModifier
  if (event.key === 'Control') return `${location}Control` as ShortcutModifier
  if (event.key === 'Alt' || event.key === 'Option') return `${location}Option` as ShortcutModifier
  if (event.key === 'Shift') return `${location}Shift` as ShortcutModifier
  if (event.key === 'Fn') return 'Fn'
  return null
}

function eventKey(event: ShortcutKeyboardEvent): ShortcutKey | null {
  if (/^Key[A-Z]$/.test(event.code || '')) return event.code!.slice(3)
  if (/^Digit[0-9]$/.test(event.code || '')) return event.code!.slice(5)
  if (event.code === 'Space') return 'Space'
  if (/^F(?:[1-9]|1\d|20)$/.test(event.code || '')) return event.code!
  return normaliseKey(event.key)
}

export function shortcutFromKeyboardEvent(event: ShortcutKeyboardEvent): string | null {
  if (event.repeat || event.key === 'Escape' || event.code === 'Escape') return null
  const exactModifiers = new Map<string, ShortcutModifier>()
  for (const code of event.modifierCodes || []) {
    const modifier = codeModifiers.get(code)
    if (modifier) exactModifiers.set(family(modifier), modifier)
  }
  const pressedModifier = modifierForEvent(event)
  if (pressedModifier) exactModifiers.set(family(pressedModifier), pressedModifier)

  const modifiers: ShortcutModifier[] = []
  const add = (generic: ShortcutModifier, pressed: boolean | undefined) => {
    const exact = exactModifiers.get(family(generic))
    if (exact) modifiers.push(exact)
    else if (pressed) modifiers.push(generic)
  }
  add('Command', event.metaKey)
  add('Control', event.ctrlKey)
  add('Option', event.altKey)
  add('Shift', event.shiftKey)
  if (exactModifiers.has('Fn') || event.getModifierState?.('Fn')) modifiers.push('Fn')

  const key = pressedModifier ? null : eventKey(event)
  try { return parseShortcut([...modifiers, ...(key ? [key] : [])].join('+')).value } catch { return null }
}

const labels: Record<ShortcutModifier | string, string> = {
  Command: 'Command', LeftCommand: 'Left Command', RightCommand: 'Right Command',
  Control: 'Control', LeftControl: 'Left Control', RightControl: 'Right Control',
  Option: 'Option', LeftOption: 'Left Option', RightOption: 'Right Option',
  Shift: 'Shift', LeftShift: 'Left Shift', RightShift: 'Right Shift', Fn: 'Globe / Fn', Space: 'Space'
}

export function formatShortcut(value: string | ParsedShortcut): string {
  const shortcut = typeof value === 'string' ? parseShortcut(value) : parseShortcut(value.value)
  return [...shortcut.modifiers, ...(shortcut.key ? [shortcut.key] : [])].map(part => labels[part] || part).join(' + ')
}
