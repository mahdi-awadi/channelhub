import { describe, test, expect } from 'bun:test'
import { formatSessionList, formatStatus, parseCommand, chunkText } from '../../src/frontends/telegram'

describe('telegram helpers', () => {
  test('formatSessionList with no sessions', () => {
    const text = formatSessionList([], null)
    expect(text).toContain('No sessions')
  })

  test('formatSessionList with sessions', () => {
    const sessions = [
      { name: 'frontend', status: 'active' as const, path: '/home/user/frontend', trust: 'ask' as const, prefix: '', uploadDir: '.', managed: false, teamIndex: 0, teamSize: 0, connectedAt: Date.now() },
      { name: 'backend', status: 'disconnected' as const, path: '/home/user/backend', trust: 'auto-approve' as const, prefix: '', uploadDir: '.', managed: true, teamIndex: 0, teamSize: 0, connectedAt: null },
    ]
    const text = formatSessionList(sessions, 'frontend')
    expect(text).toContain('frontend')
    expect(text).toContain('backend')
    expect(text).toContain('active')
  })

  test('formatStatus shows dashboard', () => {
    const sessions = [
      { name: 'frontend', status: 'active' as const, path: '/home/user/frontend', trust: 'ask' as const, prefix: 'test', uploadDir: '.', managed: false, teamIndex: 0, teamSize: 0, connectedAt: Date.now() },
    ]
    const text = formatStatus(sessions)
    expect(text).toContain('frontend')
  })

  test('parseCommand extracts command and args', () => {
    expect(parseCommand('/spawn frontend /home/user/frontend')).toEqual({
      command: 'spawn',
      args: ['frontend', '/home/user/frontend'],
    })
    expect(parseCommand('/list')).toEqual({ command: 'list', args: [] })
    expect(parseCommand('/all fix everything')).toEqual({
      command: 'all',
      args: ['fix', 'everything'],
    })
  })

  test('parseCommand returns null for non-commands', () => {
    expect(parseCommand('hello world')).toBeNull()
  })

  test('chunkText splits long messages', () => {
    const long = 'a'.repeat(5000)
    const chunks = chunkText(long, 4096)
    expect(chunks.length).toBe(2)
    expect(chunks[0].length).toBeLessThanOrEqual(4096)
  })

  test('chunkText returns single chunk for short messages', () => {
    const chunks = chunkText('short', 4096)
    expect(chunks).toEqual(['short'])
  })
})
