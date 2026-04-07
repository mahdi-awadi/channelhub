import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { loadHubConfig, saveHubConfig, loadSessions, saveSessions, HUB_DIR } from '../src/config'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

const TEST_DIR = join(import.meta.dir, '.test-hub-config')

describe('config', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('loadHubConfig returns defaults when file missing', () => {
    const config = loadHubConfig(TEST_DIR)
    expect(config.webPort).toBe(3000)
    expect(config.defaultTrust).toBe('ask')
    expect(config.telegramToken).toBe('')
    expect(config.telegramAllowFrom).toEqual([])
    expect(config.defaultUploadDir).toBe('.')
  })

  test('saveHubConfig and loadHubConfig roundtrip', () => {
    const config = {
      webPort: 4000,
      telegramToken: '123:AAH',
      telegramAllowFrom: ['12345'],
      defaultTrust: 'auto' as const,
      defaultUploadDir: 'uploads/',
    }
    saveHubConfig(config, TEST_DIR)
    const loaded = loadHubConfig(TEST_DIR)
    expect(loaded).toEqual(config)
  })

  test('loadSessions returns empty object when file missing', () => {
    const sessions = loadSessions(TEST_DIR)
    expect(sessions).toEqual({})
  })

  test('saveSessions and loadSessions roundtrip', () => {
    const sessions = {
      '/home/user/frontend': {
        name: 'frontend',
        trust: 'ask' as const,
        prefix: '',
        uploadDir: '.',
        managed: false,
        teamIndex: 0,
        teamSize: 0,
      },
    }
    saveSessions(sessions, TEST_DIR)
    const loaded = loadSessions(TEST_DIR)
    expect(loaded).toEqual(sessions)
  })

  test('saveHubConfig creates directory with mode 0o700', () => {
    const config = loadHubConfig(TEST_DIR)
    saveHubConfig(config, TEST_DIR)
    expect(existsSync(TEST_DIR)).toBe(true)
  })
})
