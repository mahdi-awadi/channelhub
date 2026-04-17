// tests/session-registry.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { SessionRegistry } from '../src/session-registry'

describe('SessionRegistry', () => {
  let registry: SessionRegistry

  beforeEach(() => {
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
  })

  test('register adds a session', () => {
    const session = registry.register('/home/user/frontend')
    expect(session.name).toBe('frontend')
    expect(session.status).toBe('active')
    expect(session.path).toBe('/home/user/frontend')
    expect(session.trust).toBe('ask')
  })

  test('register rejects duplicate path', () => {
    registry.register('/home/user/frontend')
    expect(() => registry.register('/home/user/frontend')).toThrow('already registered')
  })

  test('register appends suffix on name collision', () => {
    registry.register('/home/alice/app')
    const s2 = registry.register('/home/bob/app')
    expect(s2.name).toBe('app-2')
  })

  test('disconnect marks session disconnected', () => {
    registry.register('/home/user/frontend')
    registry.disconnect('/home/user/frontend')
    const session = registry.get('/home/user/frontend')
    expect(session?.status).toBe('disconnected')
  })

  test('unregister removes session', () => {
    registry.register('/home/user/frontend')
    registry.unregister('/home/user/frontend')
    expect(registry.get('/home/user/frontend')).toBeUndefined()
  })

  test('list returns all sessions', () => {
    registry.register('/home/user/a')
    registry.register('/home/user/b')
    expect(registry.list().length).toBe(2)
  })

  test('rename changes display name', () => {
    registry.register('/home/user/frontend')
    registry.rename('/home/user/frontend', 'my-app')
    expect(registry.get('/home/user/frontend')?.name).toBe('my-app')
  })

  test('findByName resolves path from display name', () => {
    registry.register('/home/user/frontend')
    expect(registry.findByName('frontend')).toBe('/home/user/frontend')
  })

  test('setTrust changes trust level', () => {
    registry.register('/home/user/frontend')
    registry.setTrust('/home/user/frontend', 'auto')
    expect(registry.get('/home/user/frontend')?.trust).toBe('auto')
  })

  test('setPrefix changes prefix', () => {
    registry.register('/home/user/frontend')
    registry.setPrefix('/home/user/frontend', 'You are a Next.js expert.')
    expect(registry.get('/home/user/frontend')?.prefix).toBe('You are a Next.js expert.')
  })

  test('restoreFrom loads saved sessions as disconnected', () => {
    const saved = {
      '/home/user/frontend': {
        name: 'frontend',
        trust: 'auto' as const,
        prefix: 'test',
        uploadDir: '.',
        managed: true,
        teamIndex: 0,
        teamSize: 0,
      },
    }
    registry.restoreFrom(saved)
    const s = registry.get('/home/user/frontend')
    expect(s?.name).toBe('frontend')
    expect(s?.status).toBe('disconnected')
    expect(s?.trust).toBe('auto')
  })

  test('register allows multiple sessions from same folder with different indices', () => {
    const s1 = registry.register('/home/user/app:0')
    const s2 = registry.register('/home/user/app:1')
    expect(s1.name).toBe('app')
    expect(s2.name).toBe('app-2')
    expect(registry.list().length).toBe(2)
  })

  test('getTeam returns all sessions for a folder path', () => {
    registry.register('/home/user/app:0', { teamIndex: 0, teamSize: 3 })
    registry.register('/home/user/app:1', { teamIndex: 1, teamSize: 3 })
    registry.register('/home/user/app:2', { teamIndex: 2, teamSize: 3 })
    const team = registry.getTeam('/home/user/app')
    expect(team.length).toBe(3)
    expect(team[0].teamIndex).toBe(0)
  })

  test('getTeamLead returns the index-0 session', () => {
    registry.register('/home/user/app:0', { teamIndex: 0, teamSize: 2 })
    registry.register('/home/user/app:1', { teamIndex: 1, teamSize: 2 })
    const lead = registry.getTeamLead('/home/user/app')
    expect(lead?.teamIndex).toBe(0)
  })

  test('nextTeamIndex returns next available index', () => {
    registry.register('/home/user/app:0', { teamIndex: 0, teamSize: 2 })
    registry.register('/home/user/app:1', { teamIndex: 1, teamSize: 2 })
    expect(registry.nextTeamIndex('/home/user/app')).toBe(2)
  })

  test('folderPath extracts path without index', () => {
    expect(registry.folderPath('/home/user/app:0')).toBe('/home/user/app')
    expect(registry.folderPath('/home/user/app')).toBe('/home/user/app')
  })

  test('register accepts appliedProfile and profileOverrides', () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    const session = registry.register('/home/test', {
      appliedProfile: 'careful',
      profileOverrides: { rules: ['custom'] },
    })
    expect(session.appliedProfile).toBe('careful')
    expect(session.profileOverrides).toEqual({ rules: ['custom'] })
  })

  test('toSaveFormat persists appliedProfile and profileOverrides', () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    registry.register('/home/test', {
      appliedProfile: 'tdd',
      profileOverrides: { facts: ['test fact'] },
    })
    const saved = registry.toSaveFormat()
    const entry = saved['/home/test']
    expect(entry.appliedProfile).toBe('tdd')
    expect(entry.profileOverrides).toEqual({ facts: ['test fact'] })
  })

  describe('rules & facts overrides', () => {
    const profile: import('../src/types').Profile = {
      name: 'careful',
      trust: 'ask',
      rules: ['profile rule 1', 'profile rule 2'],
      facts: ['profile fact 1'],
      prefix: '',
    }

    test('getEffectiveRules falls back to profile rules when no override', () => {
      registry.register('/home/test', { appliedProfile: 'careful' })
      expect(registry.getEffectiveRules('/home/test', [profile])).toEqual(profile.rules)
    })

    test('getEffectiveRules returns empty array when no profile and no override', () => {
      registry.register('/home/test')
      expect(registry.getEffectiveRules('/home/test', [profile])).toEqual([])
    })

    test('setRules overrides profile rules', () => {
      registry.register('/home/test', { appliedProfile: 'careful' })
      registry.setRules('/home/test', ['custom rule'])
      expect(registry.getEffectiveRules('/home/test', [profile])).toEqual(['custom rule'])
    })

    test('addRule appends to effective rules and materializes override', () => {
      registry.register('/home/test', { appliedProfile: 'careful' })
      registry.addRule('/home/test', 'extra rule', [profile])
      expect(registry.getEffectiveRules('/home/test', [profile])).toEqual([
        ...profile.rules,
        'extra rule',
      ])
    })

    test('clearRules zeroes rules even when profile has some', () => {
      registry.register('/home/test', { appliedProfile: 'careful' })
      registry.clearRules('/home/test')
      expect(registry.getEffectiveRules('/home/test', [profile])).toEqual([])
    })

    test('getEffectiveFacts falls back to profile facts', () => {
      registry.register('/home/test', { appliedProfile: 'careful' })
      expect(registry.getEffectiveFacts('/home/test', [profile])).toEqual(profile.facts)
    })

    test('addFact appends to profile facts', () => {
      registry.register('/home/test', { appliedProfile: 'careful' })
      registry.addFact('/home/test', 'fact 2', [profile])
      expect(registry.getEffectiveFacts('/home/test', [profile])).toEqual([
        ...profile.facts,
        'fact 2',
      ])
    })

    test('clearFacts empties facts override', () => {
      registry.register('/home/test', { appliedProfile: 'careful' })
      registry.clearFacts('/home/test')
      expect(registry.getEffectiveFacts('/home/test', [profile])).toEqual([])
    })

    test('rules methods no-op on unknown path', () => {
      expect(() => registry.setRules('/nope', ['x'])).not.toThrow()
      expect(() => registry.addRule('/nope', 'x', [profile])).not.toThrow()
      expect(() => registry.clearRules('/nope')).not.toThrow()
      expect(registry.getEffectiveRules('/nope', [profile])).toEqual([])
    })
  })
})
