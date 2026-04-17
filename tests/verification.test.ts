import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { probeProject, VerificationRunner } from '../src/verification'
import { SessionRegistry } from '../src/session-registry'
import type { Profile } from '../src/types'

describe('probeProject', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verify-probe-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('no package.json → empty array', () => {
    expect(probeProject(dir)).toEqual([])
  })

  test('package.json with no scripts → empty array', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }))
    expect(probeProject(dir)).toEqual([])
  })

  test('scripts.test → bun run test', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'bun test' } }),
    )
    expect(probeProject(dir)).toEqual(['bun run test'])
  })

  test('scripts.typecheck → bunx tsc --noEmit', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
    )
    expect(probeProject(dir)).toEqual(['bunx tsc --noEmit'])
  })

  test('scripts.lint → bun run lint', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { lint: 'eslint .' } }),
    )
    expect(probeProject(dir)).toEqual(['bun run lint'])
  })

  test('tsc mentioned in a non-typecheck script → bunx tsc --noEmit', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc -p tsconfig.build.json' } }),
    )
    expect(probeProject(dir)).toEqual(['bunx tsc --noEmit'])
  })

  test('all three present → ordered [test, typecheck, lint]', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        scripts: { test: 'bun test', typecheck: 'tsc --noEmit', lint: 'eslint .' },
      }),
    )
    expect(probeProject(dir)).toEqual([
      'bun run test',
      'bunx tsc --noEmit',
      'bun run lint',
    ])
  })

  test('malformed package.json → empty array (no throw)', () => {
    writeFileSync(join(dir, 'package.json'), '{ not json')
    expect(probeProject(dir)).toEqual([])
  })
})

describe('VerificationRunner.run', () => {
  let dir: string
  let registry: SessionRegistry

  const profiles = (extra: Partial<Profile> = {}): Profile[] => [
    {
      name: 'test-profile',
      trust: 'ask',
      rules: [],
      facts: [],
      prefix: '',
      verification: { commands: [] },
      ...extra,
    },
  ]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verify-run-'))
    registry = new SessionRegistry({ defaultTrust: 'ask', defaultUploadDir: '.' })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('happy path: single echo command returns pass', async () => {
    registry.register(dir, { appliedProfile: 'test-profile' })
    const runner = new VerificationRunner({
      registry,
      profiles: () => profiles({ verification: { commands: ['echo ok'] } }),
    })
    const result = await runner.run(dir)
    expect(result.status).toBe('pass')
  })

  test('isRunning is false before run, false after run', async () => {
    registry.register(dir, { appliedProfile: 'test-profile' })
    const runner = new VerificationRunner({
      registry,
      profiles: () => profiles({ verification: { commands: ['echo ok'] } }),
    })
    expect(runner.isRunning(dir)).toBe(false)
    await runner.run(dir)
    expect(runner.isRunning(dir)).toBe(false)
  })
})
