import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { probeProject } from '../src/verification'

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
