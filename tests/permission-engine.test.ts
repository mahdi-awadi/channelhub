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

  test('auto-approve allows Read tool immediately', () => {
    registry.register('/home/user/trusted')
    registry.setTrust('/home/user/trusted', 'auto')
    const result = engine.handle('/home/user/trusted', {
      requestId: 'abcde',
      toolName: 'Read',
      description: 'read a file',
      inputPreview: '{}',
      toolArgs: {},
    })
    expect(result).toEqual({ requestId: 'abcde', behavior: 'allow' })
    expect(forwarded.length).toBe(0)
  })

  test('ask mode forwards composite Bash to callback and returns null', () => {
    registry.register('/home/user/untrusted')
    const result = engine.handle('/home/user/untrusted', {
      requestId: 'fghij',
      toolName: 'Bash',
      description: 'run rm',
      inputPreview: 'rm -rf /',
      toolArgs: { command: 'cd /tmp && rm foo' },
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
      toolArgs: { command: 'cd /tmp && rm foo' },
    })
    const result = engine.resolve('fghij', 'deny')
    expect(result?.response).toEqual({ requestId: 'fghij', behavior: 'deny' })
    expect(result?.sessionPath).toBe('/home/user/untrusted')
  })

  test('resolve returns null for unknown requestId', () => {
    expect(engine.resolve('zzzzz', 'allow')).toBeNull()
  })
})

describe('PermissionEngine classifier integration', () => {
  test('Read tool always allowed regardless of trust', () => {
    const reg = new SessionRegistry({ defaultTrust: 'strict', defaultUploadDir: '.' })
    reg.register('/home/test:0')
    const engine = new PermissionEngine(reg, () => {})
    const result = engine.handle('/home/test:0', {
      requestId: 'r1',
      toolName: 'Read',
      description: 'read',
      inputPreview: '{}',
      toolArgs: {},
    })
    expect(result?.behavior).toBe('allow')
  })

  test('Dangerous Bash allowed on yolo trust', () => {
    const reg = new SessionRegistry({ defaultTrust: 'yolo', defaultUploadDir: '.' })
    reg.register('/home/test:0')
    const engine = new PermissionEngine(reg, () => {})
    const result = engine.handle('/home/test:0', {
      requestId: 'r1',
      toolName: 'Bash',
      description: 'rm',
      inputPreview: '',
      toolArgs: { command: 'rm -rf /' },
    })
    expect(result?.behavior).toBe('allow')
  })

  test('Dangerous Bash escalates on auto trust', () => {
    const reg = new SessionRegistry({ defaultTrust: 'auto', defaultUploadDir: '.' })
    reg.register('/home/test:0')
    const forwarded: any[] = []
    const engine = new PermissionEngine(reg, (req) => forwarded.push(req))
    const result = engine.handle('/home/test:0', {
      requestId: 'r1',
      toolName: 'Bash',
      description: 'rm',
      inputPreview: '',
      toolArgs: { command: 'rm -rf /' },
    })
    expect(result).toBeNull() // escalated
    expect(forwarded.length).toBe(1)
  })

  test('Benign Bash allowed on ask trust', () => {
    const reg = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    reg.register('/home/test:0')
    const engine = new PermissionEngine(reg, () => {})
    const result = engine.handle('/home/test:0', {
      requestId: 'r1',
      toolName: 'Bash',
      description: 'ls',
      inputPreview: '',
      toolArgs: { command: 'ls' },
    })
    expect(result?.behavior).toBe('allow')
  })

  test('Benign Bash escalates on strict trust', () => {
    const reg = new SessionRegistry({ defaultTrust: 'strict', defaultUploadDir: '.' })
    reg.register('/home/test:0')
    const forwarded: any[] = []
    const engine = new PermissionEngine(reg, (req) => forwarded.push(req))
    const result = engine.handle('/home/test:0', {
      requestId: 'r1',
      toolName: 'Bash',
      description: 'ls',
      inputPreview: '',
      toolArgs: { command: 'ls' },
    })
    expect(result).toBeNull() // strict escalates even logged
    expect(forwarded.length).toBe(1)
  })
})

test('activity log records non-silent decisions', () => {
  const reg = new SessionRegistry({ defaultTrust: 'auto', defaultUploadDir: '.' })
  reg.register('/home/test:0')
  const engine = new PermissionEngine(reg, () => {})
  // Silent — should NOT log
  engine.handle('/home/test:0', {
    requestId: 'r1',
    toolName: 'Read',
    description: 'read',
    inputPreview: '',
    toolArgs: {},
  })
  // Logged — should log
  engine.handle('/home/test:0', {
    requestId: 'r2',
    toolName: 'Bash',
    description: 'ls',
    inputPreview: '',
    toolArgs: { command: 'ls' },
  })
  const activity = engine.getActivity()
  expect(activity.length).toBe(1)
  expect(activity[0].toolName).toBe('Bash')
  expect(activity[0].category).toBe('logged')
  expect(activity[0].action).toBe('allowed')
})

test('activity log records escalations', () => {
  const reg = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
  reg.register('/home/test:0')
  const engine = new PermissionEngine(reg, () => {})
  engine.handle('/home/test:0', {
    requestId: 'r1',
    toolName: 'Bash',
    description: 'rm',
    inputPreview: '',
    toolArgs: { command: 'rm -rf /' },
  })
  const activity = engine.getActivity()
  expect(activity.length).toBe(1)
  expect(activity[0].category).toBe('dangerous')
  expect(activity[0].action).toBe('escalated')
})

test('activity log caps at MAX_LOG_ENTRIES', () => {
  const reg = new SessionRegistry({ defaultTrust: 'auto', defaultUploadDir: '.' })
  reg.register('/home/test:0')
  const engine = new PermissionEngine(reg, () => {})
  for (let i = 0; i < 600; i++) {
    engine.handle('/home/test:0', {
      requestId: `r${i}`,
      toolName: 'Bash',
      description: 'ls',
      inputPreview: '',
      toolArgs: { command: 'ls' },
    })
  }
  const activity = engine.getActivity()
  expect(activity.length).toBeLessThanOrEqual(500)
})
