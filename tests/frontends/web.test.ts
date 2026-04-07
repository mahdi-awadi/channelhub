// tests/frontends/web.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { WebFrontend } from '../../src/frontends/web'
import { SessionRegistry } from '../../src/session-registry'

describe('WebFrontend', () => {
  let web: WebFrontend
  let registry: SessionRegistry

  beforeEach(async () => {
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    registry.register('/home/user/frontend')
    web = new WebFrontend({
      port: 0,
      registry,
      router: null as any,
      permissions: null as any,
      socketServer: null as any,
      screenManager: null as any,
      shimCommand: 'bun run src/shim.ts',
    })
    await web.start()
  })

  afterEach(async () => {
    await web.stop()
  })

  test('GET /api/sessions returns session list', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/sessions`)
    expect(res.status).toBe(200)
    const data = await res.json() as any[]
    expect(data.length).toBe(1)
    expect(data[0].name).toBe('frontend')
  })

  test('GET / serves HTML', async () => {
    const res = await fetch(`http://localhost:${web.port}/`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('<!DOCTYPE html>')
  })
})
