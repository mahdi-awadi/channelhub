import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

// Extract and eval the formatRelativeTime function from the client HTML
// so we can test it as a pure helper.
function loadHelper(name: string): Function {
  const html = readFileSync(join(__dirname, '../../src/frontends/web-client.html'), 'utf8')
  const m = html.match(new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\s*\\}`, 'm'))
  if (!m) throw new Error(`${name} not found in web-client.html`)
  return new Function(`${m[0]}\nreturn ${name};`)()
}

describe('formatRelativeTime', () => {
  const fn = loadHelper('formatRelativeTime') as (sec: number, nowSec?: number) => string
  const NOW = 1_700_100_000

  test('seconds ago → "just now"', () => {
    expect(fn(NOW - 20, NOW)).toBe('just now')
  })

  test('minutes ago', () => {
    expect(fn(NOW - 300, NOW)).toBe('5m ago')
  })

  test('hours ago', () => {
    expect(fn(NOW - 7200, NOW)).toBe('2h ago')
  })

  test('one day → "yesterday"', () => {
    expect(fn(NOW - 86400, NOW)).toBe('yesterday')
  })

  test('multiple days → "Nd ago" up to 7 days', () => {
    expect(fn(NOW - 3 * 86400, NOW)).toBe('3d ago')
  })

  test('older than 7 days → absolute date', () => {
    const sec = NOW - 30 * 86400
    const out = fn(sec, NOW)
    // Format like "Oct 17" — test shape, not exact locale
    expect(out).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/)
  })
})
