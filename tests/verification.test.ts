import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
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

  test('failing command returns fail with exit code and tail', async () => {
    registry.register(dir, { appliedProfile: 'test-profile' })
    const runner = new VerificationRunner({
      registry,
      profiles: () => profiles({
        verification: { commands: ["echo something && exit 3"] },
      }),
    })
    const result = await runner.run(dir)
    expect(result.status).toBe('fail')
    if (result.status === 'fail') {
      expect(result.exitCode).toBe(3)
      expect(result.failedCommand).toBe('echo something && exit 3')
      expect(result.tail.join('\n')).toContain('something')
    }
  })

  test('tail is at most 20 lines', async () => {
    registry.register(dir, { appliedProfile: 'test-profile' })
    const runner = new VerificationRunner({
      registry,
      profiles: () => profiles({
        verification: { commands: ['for i in $(seq 1 50); do echo line$i; done; exit 1'] },
      }),
    })
    const result = await runner.run(dir)
    expect(result.status).toBe('fail')
    if (result.status === 'fail') {
      expect(result.tail.length).toBeLessThanOrEqual(20)
      expect(result.tail.join('\n')).toContain('line50')
      expect(result.tail.join('\n')).not.toContain('line10')
    }
  })

  test('stops on first failure — second command never runs', async () => {
    registry.register(dir, { appliedProfile: 'test-profile' })
    const sentinel = join(dir, 'sentinel')
    const runner = new VerificationRunner({
      registry,
      profiles: () => profiles({
        verification: {
          commands: ['exit 1', `touch ${sentinel}`],
        },
      }),
    })
    const result = await runner.run(dir)
    expect(result.status).toBe('fail')
    expect(existsSync(sentinel)).toBe(false)
  })

  test('exceeding timeout returns error(timeout)', async () => {
    registry.register(dir, { appliedProfile: 'test-profile' })
    const runner = new VerificationRunner({
      registry,
      profiles: () => profiles({
        verification: { commands: ['sleep 5'] },
      }),
      timeoutMs: 100,
    })
    const result = await runner.run(dir)
    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.reason).toBe('timeout')
      expect(result.details).toBe('sleep 5')
    }
  })

  test('command runs in session project path', async () => {
    registry.register(dir, { appliedProfile: 'test-profile' })
    const marker = join(dir, 'pwd-marker')
    const runner = new VerificationRunner({
      registry,
      profiles: () => profiles({
        verification: { commands: [`pwd > ${marker}`] },
      }),
    })
    await runner.run(dir)
    const captured = readFileSync(marker, 'utf8').trim()
    // macOS resolves /tmp to /private/tmp; accept suffix match.
    expect(captured.endsWith(dir) || captured === dir).toBe(true)
  })

  test('CI=true is set in subprocess env', async () => {
    registry.register(dir, { appliedProfile: 'test-profile' })
    const marker = join(dir, 'env-marker')
    const runner = new VerificationRunner({
      registry,
      profiles: () => profiles({
        verification: { commands: [`echo $CI > ${marker}`] },
      }),
    })
    await runner.run(dir)
    expect(readFileSync(marker, 'utf8').trim()).toBe('true')
  })

  test('second run while first is in-flight returns already-running', async () => {
    registry.register(dir, { appliedProfile: 'test-profile' })
    const runner = new VerificationRunner({
      registry,
      profiles: () => profiles({
        verification: { commands: ['sleep 0.2'] },
      }),
    })
    const first = runner.run(dir)
    // Give the first run a tick to mark itself as running.
    await new Promise(r => setTimeout(r, 10))
    expect(runner.isRunning(dir)).toBe(true)
    const second = await runner.run(dir)
    expect(second.status).toBe('error')
    if (second.status === 'error') {
      expect(second.reason).toBe('already-running')
    }
    await first
    expect(runner.isRunning(dir)).toBe(false)
  })
})
