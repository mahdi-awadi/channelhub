// tests/screen-manager.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { $ } from 'bun'
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

  test('gracefulKill is a no-op for unknown name', async () => {
    // Should not throw and should not affect state.
    await manager.gracefulKill('does-not-exist')
    expect(manager.isManaged('does-not-exist')).toBe(false)
  })

  test('gracefulKill falls back to hard kill when session ignores /exit', async () => {
    const name = 'test-fallback'
    const sessionName = `hub-${name}`

    // Start a fake tmux session running `sleep 60` — it won't respond to /exit.
    await $`tmux new-session -d -s ${sessionName} sleep 60`.quiet()

    // Inject it into ScreenManager's managed map so gracefulKill treats it as managed.
    ;(manager as any).managed.set(name, {
      sessionName,
      projectPath: '/tmp',
      respawnEnabled: true,
    })

    // Sanity check: it's running before we call gracefulKill.
    expect(await manager.isSessionRunning(sessionName)).toBe(true)

    // Run gracefulKill. This should take ~3 seconds (cancel delay + timeout)
    // before the fallback fires.
    const start = Date.now()
    await manager.gracefulKill(name)
    const elapsed = Date.now() - start

    // The fallback should have killed the tmux session.
    expect(await manager.isSessionRunning(sessionName)).toBe(false)

    // The managed map should no longer contain the entry.
    expect(manager.isManaged(name)).toBe(false)

    // Sanity check on timing: GRACEFUL_CANCEL_DELAY (300) + GRACEFUL_TIMEOUT (3000)
    // = ~3300ms minimum. Allow a little slack below and a generous ceiling.
    expect(elapsed).toBeGreaterThanOrEqual(3200)
    expect(elapsed).toBeLessThan(6000)
  }, 10000) // 10s timeout for this test since it waits ~3.3s
})
