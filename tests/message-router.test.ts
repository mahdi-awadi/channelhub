// tests/message-router.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { MessageRouter } from '../src/message-router'
import { SessionRegistry } from '../src/session-registry'

describe('MessageRouter', () => {
  let registry: SessionRegistry
  let router: MessageRouter
  const sent: Array<{ path: string; content: string }> = []
  const delivered: Array<{ sessionName: string; text: string }> = []

  beforeEach(() => {
    sent.length = 0
    delivered.length = 0
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
    router = new MessageRouter(
      registry,
      (path, content, meta) => { sent.push({ path, content }); return true },
      (sessionName, text, files) => { delivered.push({ sessionName, text }) },
    )
  })

  test('routeToSession sends to active session with prefix', () => {
    registry.register('/home/user/frontend')
    registry.setPrefix('/home/user/frontend', 'You are a Next.js expert.')
    router.routeToSession('frontend', 'fix the login', 'telegram', 'user1')
    expect(sent.length).toBe(1)
    expect(sent[0].content).toBe('You are a Next.js expert. fix the login')
  })

  test('routeToSession sends without prefix when empty', () => {
    registry.register('/home/user/frontend')
    router.routeToSession('frontend', 'fix the login', 'telegram', 'user1')
    expect(sent[0].content).toBe('fix the login')
  })

  test('routeToSession returns false for unknown session', () => {
    const ok = router.routeToSession('unknown', 'hello', 'telegram', 'user1')
    expect(ok).toBe(false)
  })

  test('routeFromSession delivers to frontends', () => {
    registry.register('/home/user/frontend')
    router.routeFromSession('/home/user/frontend', 'done!', [])
    expect(delivered.length).toBe(1)
    expect(delivered[0].sessionName).toBe('frontend')
    expect(delivered[0].text).toBe('done!')
  })

  test('broadcast sends to all active sessions', () => {
    registry.register('/home/user/a')
    registry.register('/home/user/b')
    router.broadcast('update deps', 'telegram', 'user1')
    expect(sent.length).toBe(2)
  })

  test('parseTargetedMessage extracts session name', () => {
    registry.register('/home/user/frontend')
    const result = router.parseTargetedMessage('/frontend fix the bug')
    expect(result).toEqual({ sessionName: 'frontend', text: 'fix the bug' })
  })

  test('parseTargetedMessage returns null for plain text', () => {
    expect(router.parseTargetedMessage('fix the bug')).toBeNull()
  })

  test('parseTargetedMessage returns null for commands', () => {
    expect(router.parseTargetedMessage('/list')).toBeNull()
    expect(router.parseTargetedMessage('/spawn x y')).toBeNull()
    expect(router.parseTargetedMessage('/all hello')).toBeNull()
  })
})
