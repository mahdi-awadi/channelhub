import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { encodeProjectPath, isInsideProjectsRoot, listPriorSessions } from '../src/claude-sessions'
import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'

describe('encodeProjectPath', () => {
  test('replaces slashes with dashes', () => {
    expect(encodeProjectPath('/home/user/proj')).toBe('-home-user-proj')
  })

  test('handles trailing slash', () => {
    expect(encodeProjectPath('/home/user/proj/')).toBe('-home-user-proj-')
  })

  test('handles root', () => {
    expect(encodeProjectPath('/')).toBe('-')
  })
})

describe('isInsideProjectsRoot', () => {
  const ROOT = join(homedir(), '.claude', 'projects')

  test('accepts a direct child directory', () => {
    expect(isInsideProjectsRoot(join(ROOT, '-home-user-proj'))).toBe(true)
  })

  test('rejects a path that escapes via ..', () => {
    expect(isInsideProjectsRoot(join(ROOT, '..', 'other'))).toBe(false)
  })

  test('rejects an unrelated absolute path', () => {
    expect(isInsideProjectsRoot('/etc/passwd')).toBe(false)
  })

  test('rejects the root itself (must be a child)', () => {
    expect(isInsideProjectsRoot(ROOT)).toBe(false)
  })
})

describe('listPriorSessions', () => {
  // Use a real-looking project cwd so the function exercises its own encoding.
  const PROJECT_CWD = '/home/user/proj'
  let tmpProjectsRoot: string
  let storageDir: string

  beforeEach(() => {
    tmpProjectsRoot = mkdtempSync(join(tmpdir(), 'claude-sessions-'))
    storageDir = join(tmpProjectsRoot, encodeProjectPath(PROJECT_CWD))
    mkdirSync(storageDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpProjectsRoot, { recursive: true, force: true })
  })

  function writeJsonl(id: string, lines: unknown[], mtimeSec: number) {
    const file = join(storageDir, `${id}.jsonl`)
    writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    utimesSync(file, mtimeSec, mtimeSec)
  }

  test('returns sessions newest-first with first user message', async () => {
    writeJsonl('aaaa1111-2222-3333-4444-555555555555', [
      { type: 'summary', text: 'meta' },
      { type: 'user', message: { role: 'user', content: 'fix the bug' } },
      { type: 'assistant', message: { role: 'assistant', content: 'ok' } },
    ], 1_700_000_100)

    writeJsonl('bbbb1111-2222-3333-4444-555555555555', [
      { type: 'user', message: { role: 'user', content: 'add multi theme dark light' } },
    ], 1_700_000_200)

    const list = await listPriorSessions(PROJECT_CWD, { rootOverride: tmpProjectsRoot })
    expect(list.length).toBe(2)
    expect(list[0].id).toBe('bbbb1111-2222-3333-4444-555555555555')
    expect(list[0].firstUserMessage).toBe('add multi theme dark light')
    expect(list[1].id).toBe('aaaa1111-2222-3333-4444-555555555555')
    expect(list[1].firstUserMessage).toBe('fix the bug')
    expect(list[0].mtime).toBeGreaterThan(list[1].mtime)
  })

  test('truncates long first user messages to 120 chars', async () => {
    const long = 'x'.repeat(500)
    writeJsonl('cccc1111-2222-3333-4444-555555555555', [
      { type: 'user', message: { role: 'user', content: long } },
    ], 1_700_000_300)
    const list = await listPriorSessions(PROJECT_CWD, { rootOverride: tmpProjectsRoot })
    expect(list[0].firstUserMessage.length).toBeLessThanOrEqual(120)
  })

  test('returns empty array when project dir does not exist', async () => {
    const list = await listPriorSessions('/nope/definitely/missing', { rootOverride: tmpProjectsRoot })
    expect(list).toEqual([])
  })

  test('caps results at 10 entries', async () => {
    for (let i = 0; i < 15; i++) {
      writeJsonl(`cap0${i.toString().padStart(3, '0')}-2222-3333-4444-555555555555`, [
        { type: 'user', message: { role: 'user', content: `msg ${i}` } },
      ], 1_700_000_400 + i)
    }
    const list = await listPriorSessions(PROJECT_CWD, { rootOverride: tmpProjectsRoot })
    expect(list.length).toBe(10)
  })

  test('skips files that cannot be parsed', async () => {
    writeJsonl('good1111-2222-3333-4444-555555555555', [
      { type: 'user', message: { role: 'user', content: 'good' } },
    ], 1_700_000_500)
    writeFileSync(join(storageDir, 'bad1111-2222-3333-4444-555555555555.jsonl'), '\x00not-json\x00')
    const list = await listPriorSessions(PROJECT_CWD, { rootOverride: tmpProjectsRoot })
    expect(list.some(s => s.id.startsWith('good1111'))).toBe(true)
  })

  test('falls back to "(no messages)" when no user line is present', async () => {
    writeJsonl('meta1111-2222-3333-4444-555555555555', [
      { type: 'summary', text: 'only meta' },
    ], 1_700_000_600)
    const list = await listPriorSessions(PROJECT_CWD, { rootOverride: tmpProjectsRoot })
    expect(list[0].firstUserMessage).toBe('(no messages)')
  })

  test('project path whose encoded dir is not present returns empty', async () => {
    // A cwd that doesn't correspond to any subdir of the override root.
    await expect(
      listPriorSessions('/etc/passwd', { rootOverride: tmpProjectsRoot })
    ).resolves.toEqual([])
  })
})
