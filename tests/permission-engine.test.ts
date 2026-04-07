// tests/permission-engine.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { PermissionEngine } from '../src/permission-engine'
import { SessionRegistry } from '../src/session-registry'

describe('PermissionEngine', () => {
  let registry: SessionRegistry
  let engine: PermissionEngine
  const forwarded: Array<{ sessionName: string; requestId: string }> = []

  beforeEach(() => {
    forwarded.length = 0
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    engine = new PermissionEngine(registry, (req) => {
      forwarded.push({ sessionName: req.sessionName, requestId: req.requestId })
    })
  })

  test('auto-approve returns allow immediately', () => {
    registry.register('/home/user/trusted')
    registry.setTrust('/home/user/trusted', 'auto-approve')
    const result = engine.handle('/home/user/trusted', {
      requestId: 'abcde',
      toolName: 'Bash',
      description: 'run ls',
      inputPreview: 'ls',
    })
    expect(result).toEqual({ requestId: 'abcde', behavior: 'allow' })
    expect(forwarded.length).toBe(0)
  })

  test('ask mode forwards to callback and returns null', () => {
    registry.register('/home/user/untrusted')
    const result = engine.handle('/home/user/untrusted', {
      requestId: 'fghij',
      toolName: 'Bash',
      description: 'run rm',
      inputPreview: 'rm -rf /',
    })
    expect(result).toBeNull()
    expect(forwarded.length).toBe(1)
    expect(forwarded[0].requestId).toBe('fghij')
  })

  test('resolve sends stored response', () => {
    registry.register('/home/user/untrusted')
    engine.handle('/home/user/untrusted', {
      requestId: 'fghij',
      toolName: 'Bash',
      description: 'run rm',
      inputPreview: 'rm -rf /',
    })
    const result = engine.resolve('fghij', 'deny')
    expect(result?.response).toEqual({ requestId: 'fghij', behavior: 'deny' })
    expect(result?.sessionPath).toBe('/home/user/untrusted')
  })

  test('resolve returns null for unknown requestId', () => {
    expect(engine.resolve('zzzzz', 'allow')).toBeNull()
  })
})
