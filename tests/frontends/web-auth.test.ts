// tests/frontends/web-auth.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createHash, createHmac } from 'crypto'
import {
  WebFrontend,
  signSession,
  verifySession,
  sanitizeFilename,
  pathInsideRoot,
} from '../../src/frontends/web'
import { SessionRegistry } from '../../src/session-registry'

const TOKEN = 'test-bot-token-abc123'
const ALLOWED = '123'
const OTHER = '999'

function buildTelegramAuthBody(userId: string, authDate: number, token = TOKEN): Record<string, string | number> {
  const userData: Record<string, string | number> = {
    id: userId,
    first_name: 'Test',
    auth_date: authDate,
  }
  const secretKey = createHash('sha256').update(token).digest()
  const checkString = Object.keys(userData)
    .sort()
    .map(k => `${k}=${userData[k]}`)
    .join('\n')
  const hash = createHmac('sha256', secretKey).update(checkString).digest('hex')
  return { ...userData, hash }
}

function authCookie(userId = ALLOWED): string {
  return `hub_session=${signSession(userId, TOKEN)}`
}

describe('signSession / verifySession', () => {
  test('round-trips a valid token', () => {
    const token = signSession(ALLOWED, TOKEN, 1_000_000)
    expect(verifySession(token, TOKEN, 3600, 1_000_000)).toEqual({ userId: ALLOWED })
  })

  test('rejects wrong secret', () => {
    const token = signSession(ALLOWED, TOKEN)
    expect(verifySession(token, 'different-secret')).toBeNull()
  })

  test('rejects tampered payload', () => {
    const token = signSession(ALLOWED, TOKEN)
    const [payload, mac] = token.split('.')
    const tampered = Buffer.from(JSON.stringify({ userId: 'attacker', issuedAt: Date.now() })).toString('base64url')
    expect(verifySession(`${tampered}.${mac}`, TOKEN)).toBeNull()
  })

  test('rejects expired tokens', () => {
    const issuedAt = 1_000_000
    const token = signSession(ALLOWED, TOKEN, issuedAt)
    // maxAge 3600s; now is 2 hours later
    expect(verifySession(token, TOKEN, 3600, issuedAt + 2 * 3600 * 1000)).toBeNull()
  })

  test('rejects garbage input', () => {
    expect(verifySession('', TOKEN)).toBeNull()
    expect(verifySession('not-a-token', TOKEN)).toBeNull()
    expect(verifySession('a.b.c', TOKEN)).toBeNull()
  })
})

describe('sanitizeFilename', () => {
  test('strips path components', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('/abs/path/file.txt')).toBe('file.txt')
  })

  test('replaces unsafe chars with underscore', () => {
    expect(sanitizeFilename('foo bar.txt')).toBe('foo_bar.txt')
    expect(sanitizeFilename('rm -rf.sh')).toBe('rm_-rf.sh')
    expect(sanitizeFilename('a;b|c.md')).toBe('a_b_c.md')
  })

  test('rejects leading dots', () => {
    expect(sanitizeFilename('.bashrc')).toBe('_bashrc')
    expect(sanitizeFilename('...hidden')).toBe('_hidden')
  })

  test('preserves inner dots', () => {
    expect(sanitizeFilename('archive.tar.gz')).toBe('archive.tar.gz')
  })

  test('never returns empty', () => {
    expect(sanitizeFilename('///')).toBe('file')
    expect(sanitizeFilename('..')).toBe('file')
  })
})

describe('pathInsideRoot', () => {
  test('accepts paths inside root', () => {
    expect(pathInsideRoot('/home/u/proj/file', '/home/u/proj')).toBe('/home/u/proj/file')
  })

  test('rejects parent traversal', () => {
    expect(pathInsideRoot('/home/u/proj/../other/file', '/home/u/proj')).toBeNull()
  })

  test('rejects sibling directories', () => {
    expect(pathInsideRoot('/home/u/other/file', '/home/u/proj')).toBeNull()
  })

  test('accepts root itself', () => {
    expect(pathInsideRoot('/home/u/proj', '/home/u/proj')).toBe('/home/u/proj')
  })
})

describe('POST /api/auth/telegram', () => {
  let web: WebFrontend
  let registry: SessionRegistry

  beforeEach(async () => {
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    web = new WebFrontend({
      port: 0,
      registry,
      router: null as any,
      permissions: null as any,
      socketServer: null as any,
      screenManager: null as any,
      telegramToken: TOKEN,
      telegramBotUsername: '',
      telegramAllowFrom: [ALLOWED],
      taskMonitor: null,
    })
    await web.start()
  })

  afterEach(async () => {
    await web.stop()
  })

  test('accepts correct HMAC and issues Set-Cookie', async () => {
    const authDate = Math.floor(Date.now() / 1000)
    const res = await fetch(`http://localhost:${web.port}/api/auth/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTelegramAuthBody(ALLOWED, authDate)),
    })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('hub_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Max-Age=86400')
  })

  test('rejects wrong hash with 403', async () => {
    const authDate = Math.floor(Date.now() / 1000)
    const body = buildTelegramAuthBody(ALLOWED, authDate)
    body.hash = 'deadbeef'.repeat(8)
    const res = await fetch(`http://localhost:${web.port}/api/auth/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(403)
  })

  test('rejects expired auth_date with 403', async () => {
    const expired = Math.floor(Date.now() / 1000) - 86401
    const res = await fetch(`http://localhost:${web.port}/api/auth/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTelegramAuthBody(ALLOWED, expired)),
    })
    expect(res.status).toBe(403)
  })

  test('rejects user not in allowFrom with 403', async () => {
    const authDate = Math.floor(Date.now() / 1000)
    const res = await fetch(`http://localhost:${web.port}/api/auth/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTelegramAuthBody(OTHER, authDate)),
    })
    expect(res.status).toBe(403)
  })

  test('empty allowFrom blocks auth entirely', async () => {
    await web.stop()
    const web2 = new WebFrontend({
      port: 0,
      registry,
      router: null as any,
      permissions: null as any,
      socketServer: null as any,
      screenManager: null as any,
      telegramToken: TOKEN,
      telegramBotUsername: '',
      telegramAllowFrom: [],
      taskMonitor: null,
    })
    await web2.start()
    try {
      const authDate = Math.floor(Date.now() / 1000)
      const res = await fetch(`http://localhost:${web2.port}/api/auth/telegram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTelegramAuthBody(ALLOWED, authDate)),
      })
      expect(res.status).toBe(403)
    } finally {
      await web2.stop()
    }
  })

  test('missing hash returns 400', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/auth/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ALLOWED }),
    })
    expect(res.status).toBe(400)
  })
})

describe('API auth middleware', () => {
  let web: WebFrontend

  beforeEach(async () => {
    const registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    web = new WebFrontend({
      port: 0,
      registry,
      router: null as any,
      permissions: null as any,
      socketServer: null as any,
      screenManager: null as any,
      telegramToken: TOKEN,
      telegramBotUsername: '',
      telegramAllowFrom: [ALLOWED],
      taskMonitor: null,
    })
    await web.start()
  })

  afterEach(async () => {
    await web.stop()
  })

  test('GET /api/sessions without cookie → 401', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/sessions`)
    expect(res.status).toBe(401)
  })

  test('GET /api/sessions with valid cookie → 200', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/sessions`, {
      headers: { Cookie: authCookie() },
    })
    expect(res.status).toBe(200)
  })

  test('GET /api/sessions with tampered cookie → 401', async () => {
    const res = await fetch(`http://localhost:${web.port}/api/sessions`, {
      headers: { Cookie: 'hub_session=garbage.token' },
    })
    expect(res.status).toBe(401)
  })

  test('cookie for non-allowlisted user → 401', async () => {
    // Forge a valid-signature cookie for OTHER (who is not in allowFrom).
    const cookie = `hub_session=${signSession(OTHER, TOKEN)}`
    const res = await fetch(`http://localhost:${web.port}/api/sessions`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(401)
  })

  test('GET / (static) serves without auth', async () => {
    const res = await fetch(`http://localhost:${web.port}/`)
    expect(res.status).toBe(200)
  })

  test('WebSocket upgrade without cookie → 401', async () => {
    const res = await fetch(`http://localhost:${web.port}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    })
    expect(res.status).toBe(401)
  })
})
