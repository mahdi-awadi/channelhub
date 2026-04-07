// tests/screen-manager.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { ScreenManager } from '../src/screen-manager'

describe('ScreenManager', () => {
  let manager: ScreenManager

  beforeEach(() => {
    manager = new ScreenManager()
  })

  afterEach(async () => {
    await manager.killAll()
  })

  test('isSessionRunning returns false for non-existent session', async () => {
    const running = await manager.isSessionRunning('hub-nonexistent-12345')
    expect(running).toBe(false)
  })

  test('listSessions returns array', async () => {
    const sessions = await manager.listSessions()
    expect(Array.isArray(sessions)).toBe(true)
  })

  test('isManaged returns false for unknown name', () => {
    expect(manager.isManaged('unknown')).toBe(false)
  })

  test('spawnTeam is a function', () => {
    expect(typeof manager.spawnTeam).toBe('function')
  })

  test('addTeammate is a function', () => {
    expect(typeof manager.addTeammate).toBe('function')
  })
})
