// tests/cli.test.ts
import { describe, test, expect } from 'bun:test'
import { parseCliArgs } from '../src/cli'

describe('CLI arg parsing', () => {
  test('parses list command', () => {
    expect(parseCliArgs(['list'])).toEqual({ command: 'list', args: [] })
  })

  test('parses spawn with name and path', () => {
    expect(parseCliArgs(['spawn', 'frontend', '/home/user/frontend'])).toEqual({
      command: 'spawn',
      args: ['frontend', '/home/user/frontend'],
    })
  })

  test('parses send with name and message', () => {
    expect(parseCliArgs(['send', 'frontend', 'fix the bug'])).toEqual({
      command: 'send',
      args: ['frontend', 'fix the bug'],
    })
  })

  test('returns help for empty args', () => {
    expect(parseCliArgs([])).toEqual({ command: 'help', args: [] })
  })

  test('parses trust with name and level', () => {
    expect(parseCliArgs(['trust', 'frontend', 'auto'])).toEqual({
      command: 'trust',
      args: ['frontend', 'auto'],
    })
  })
})
