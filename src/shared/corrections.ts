import type { Correction } from './types'

export const MAX_CORRECTIONS = 200
const MAX_PHRASE = 80
const key = (value: string) => value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en')

export function validateCorrections(value: unknown): Correction[] {
  if (!Array.isArray(value) || value.length > MAX_CORRECTIONS) throw new Error(`Keep at most ${MAX_CORRECTIONS} saved corrections.`)
  const seen = new Set<string>()
  return value.map(item => {
    if (!item || typeof item.from !== 'string' || typeof item.to !== 'string' ||
      /[\u0000-\u001f\u007f]/u.test(item.from + item.to)) throw new Error('Corrections must be short words or phrases on one line.')
    const from = item.from.trim().replace(/\s+/gu, ' ')
    const to = item.to.trim().replace(/\s+/gu, ' ')
    if (!from || !to || from.length > MAX_PHRASE || to.length > MAX_PHRASE || from === to) throw new Error(`Choose different phrases, each between 1 and ${MAX_PHRASE} characters.`)
    if (seen.has(key(from))) throw new Error(`A correction for “${from}” already exists. Remove it before adding a replacement.`)
    seen.add(key(from))
    return { from, to }
  })
}

// One pass over the original text: longest phrase wins, and replacements cannot
// trigger other replacements. Callback output is literal, including $ characters.
export function applyCorrections(text: string, corrections: Correction[]): string {
  if (!corrections.length || !text) return text
  const rules = [...corrections].sort((a, b) => b.from.length - a.from.length)
  const replacements = new Map(rules.map(rule => [key(rule.from), rule.to]))
  const phrases = rules.map(rule => rule.from.split(/\s+/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'))
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_'’])(?:${phrases.join('|')})(?![\\p{L}\\p{N}_'’])`, 'giu')
  return text.replace(pattern, match => replacements.get(key(match)) ?? match)
}

interface Word { text: string; start: number; end: number }
function words(text: string): Word[] {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)].map(match => ({ text: match[0], start: match.index!, end: match.index! + match[0].length }))
}

// Suggestions are never saved automatically. Ignore punctuation-only edits,
// insertions/deletions and broad rewrites; the user reviews every remaining pair.
export function suggestCorrections(original: string, corrected: string): Correction[] {
  if (original.length > 10_000 || corrected.length > 10_000) return []
  const before = words(original), after = words(corrected)
  if (!before.length || !after.length || before.length > 500 || after.length > 500) return []
  const grid = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1))
  for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--) {
    grid[i][j] = before[i].text === after[j].text ? 1 + grid[i + 1][j + 1] : Math.max(grid[i + 1][j], grid[i][j + 1])
  }
  if (before.length > 3 && (before.length - grid[0][0]) / before.length > 0.5) return []
  const suggestions: Correction[] = []
  let i = 0, j = 0
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i].text === after[j].text) { i++; j++; continue }
    const startI = i, startJ = j
    while (i < before.length || j < after.length) {
      if (i < before.length && j < after.length && before[i].text === after[j].text) break
      if (i < before.length && (j === after.length || grid[i + 1][j] >= grid[i][j + 1])) i++
      else j++
    }
    if (i > startI && j > startJ && i - startI <= 4 && j - startJ <= 4) {
      const from = original.slice(before[startI].start, before[i - 1].end)
      const to = corrected.slice(after[startJ].start, after[j - 1].end)
      try {
        const [rule] = validateCorrections([{ from, to }])
        if (!suggestions.some(item => key(item.from) === key(rule.from))) suggestions.push(rule)
      } catch { /* A long or multiline phrase is not a vocabulary correction. */ }
    }
  }
  return suggestions
}
