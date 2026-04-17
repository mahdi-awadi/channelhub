# Verification Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a subprocess-based verification runner that executes a session's profile-defined commands (or auto-detected `package.json` scripts) on `/verify <session>` and notifies on failure.

**Architecture:** One new module `src/verification.ts` exposing a `VerificationRunner` class and `probeProject` function. Wires into `daemon.ts` (construction) and `frontends/telegram.ts` (the `/verify` command). Sequential command execution with stop-on-first-failure, 120s timeout per command, one concurrent run per session. Silent ✅ on success; detailed failure message with 20-line tail on failure.

**Tech Stack:** Bun (`Bun.spawn` for subprocess), TypeScript, bun:test, grammy (existing Telegram bot).

**Reference spec:** `docs/superpowers/specs/2026-04-17-verification-runner-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/verification.ts` | **new** — `VerificationRunner` class, `VerificationResult` type, `probeProject` function |
| `src/profiles.ts` | Add `verification.commands` defaults to `tdd`, `careful` built-in profiles |
| `src/daemon.ts` | Construct `VerificationRunner`, pass to `TelegramFrontend` deps |
| `src/frontends/telegram.ts` | `/verify <session>` command handler, result formatter, menu registration |
| `tests/verification.test.ts` | **new** — unit tests for `probeProject` and `VerificationRunner` |
| `tests/integration.test.ts` | Append an end-to-end `/verify` test with a mocked grammy context |
| `README.md` | Document `/verify` and `verification.commands` in profile |
| `CLAUDE.md` | Mention the runner in architecture + key design decisions |
| `CHANGELOG.md` | Entry for sub-phase 1d (create file if missing) |

---

## Task 1: Scaffold `verification.ts` with `VerificationResult` type and `probeProject`

**Files:**
- Create: `src/verification.ts`
- Create: `tests/verification.test.ts`

- [ ] **Step 1: Write failing tests for `probeProject`**

Create `tests/verification.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — expect "module not found" failure**

```bash
bun test tests/verification.test.ts 2>&1 | tail -10
```

Expected: error about missing `../src/verification` module.

- [ ] **Step 3: Create `src/verification.ts` with type + `probeProject`**

```typescript
// src/verification.ts
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

export type VerificationResult =
  | { status: 'pass' }
  | { status: 'fail'; failedCommand: string; exitCode: number; tail: string[] }
  | {
      status: 'error'
      reason: 'timeout' | 'no-commands' | 'spawn-failed' | 'already-running'
      details: string
    }

export function probeProject(projectPath: string): string[] {
  const pkgPath = join(projectPath, 'package.json')
  if (!existsSync(pkgPath)) return []

  let pkg: { scripts?: Record<string, string> }
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    return []
  }

  const scripts = pkg.scripts ?? {}
  const out: string[] = []

  if (typeof scripts.test === 'string') {
    out.push('bun run test')
  }

  const hasTypecheckKey = typeof scripts.typecheck === 'string'
  const mentionsTsc = Object.values(scripts).some(v => /\btsc\b/.test(String(v)))
  if (hasTypecheckKey || mentionsTsc) {
    out.push('bunx tsc --noEmit')
  }

  if (typeof scripts.lint === 'string') {
    out.push('bun run lint')
  }

  return out
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun test tests/verification.test.ts 2>&1 | tail -10
```

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/verification.ts tests/verification.test.ts
git commit -m "feat(verification): probeProject detects package.json scripts

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `VerificationRunner` happy path + `isRunning`

**Files:**
- Modify: `src/verification.ts`
- Modify: `tests/verification.test.ts`

- [ ] **Step 1: Append failing tests**

Add to `tests/verification.test.ts`, inside a new describe block appended at the bottom:

```typescript
import { VerificationRunner } from '../src/verification'
import { SessionRegistry } from '../src/session-registry'
import type { Profile } from '../src/types'

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
```

- [ ] **Step 2: Run tests — expect failure**

```bash
bun test tests/verification.test.ts 2>&1 | tail -10
```

Expected: cannot find `VerificationRunner` export.

- [ ] **Step 3: Implement `VerificationRunner` class (minimal, only pass path)**

Append to `src/verification.ts`:

```typescript
import type { SessionRegistry } from './session-registry'
import type { Profile } from './types'

const DEFAULT_TIMEOUT_MS = 120_000
const TAIL_LINES = 20
const RING_LINES = 200

export interface VerificationRunnerDeps {
  registry: SessionRegistry
  profiles: () => Profile[]
  probe?: (projectPath: string) => string[]
  timeoutMs?: number
}

export class VerificationRunner {
  private deps: VerificationRunnerDeps
  private running = new Set<string>()
  private timeoutMs: number
  private probeFn: (projectPath: string) => string[]

  constructor(deps: VerificationRunnerDeps) {
    this.deps = deps
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.probeFn = deps.probe ?? probeProject
  }

  isRunning(sessionPath: string): boolean {
    return this.running.has(sessionPath)
  }

  async run(sessionPath: string): Promise<VerificationResult> {
    const session = this.deps.registry.get(sessionPath)
    if (!session) {
      return { status: 'error', reason: 'spawn-failed', details: 'session not registered' }
    }

    this.running.add(sessionPath)
    try {
      const commands = this.resolveCommands(session.appliedProfile, session.path)
      if (commands.length === 0) {
        return { status: 'error', reason: 'no-commands', details: session.name }
      }

      for (const cmd of commands) {
        const res = await this.execOne(cmd, session.path)
        if (res.status !== 'pass') return res
      }
      return { status: 'pass' }
    } finally {
      this.running.delete(sessionPath)
    }
  }

  private resolveCommands(appliedProfile: string | undefined, projectPath: string): string[] {
    const profile = appliedProfile
      ? this.deps.profiles().find(p => p.name === appliedProfile)
      : undefined
    const fromProfile = profile?.verification?.commands ?? []
    if (fromProfile.length > 0) return fromProfile
    return this.probeFn(projectPath)
  }

  private async execOne(command: string, cwd: string): Promise<VerificationResult> {
    const proc = Bun.spawn(['bash', '-c', command], {
      cwd,
      env: { ...process.env, CI: 'true' },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (exitCode === 0) return { status: 'pass' }

    const merged = (stdoutText + stderrText).split('\n')
    const tail = merged.slice(Math.max(0, merged.length - TAIL_LINES))
    return { status: 'fail', failedCommand: command, exitCode, tail }
  }
}
```

Note on merging: the pass path only needs exit code 0, so we return without further work. The `merged` slice runs only on failure.

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun test tests/verification.test.ts 2>&1 | tail -10
```

Expected: all tests pass (10 probe + 2 runner = 12 tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/verification.ts tests/verification.test.ts
git commit -m "feat(verification): VerificationRunner with pass path

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Failure path with tail + stop-on-first-failure

**Files:**
- Modify: `tests/verification.test.ts`

(no implementation change — the runner from Task 2 already handles this; this task verifies behavior under test.)

- [ ] **Step 1: Add failure tests**

Inside the `describe('VerificationRunner.run', ...)` block in `tests/verification.test.ts`, append:

```typescript
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
```

Add `existsSync` to the top import if missing:
```typescript
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs'
```

- [ ] **Step 2: Run tests — expect PASS (implementation already covers this)**

```bash
bun test tests/verification.test.ts 2>&1 | tail -10
```

Expected: all 15 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/verification.test.ts
git commit -m "test(verification): failure path, 20-line tail, stop-on-first-fail

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Timeout handling

**Files:**
- Modify: `src/verification.ts`
- Modify: `tests/verification.test.ts`

- [ ] **Step 1: Add failing timeout test**

Append to the runner describe in `tests/verification.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
bun test tests/verification.test.ts 2>&1 | tail -10
```

Expected: the timeout test fails (runner currently has no timeout; it waits forever).

- [ ] **Step 3: Add timeout to `execOne`**

Replace the `execOne` method in `src/verification.ts` with:

```typescript
private async execOne(command: string, cwd: string): Promise<VerificationResult> {
  const proc = Bun.spawn(['bash', '-c', command], {
    cwd,
    env: { ...process.env, CI: 'true' },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, this.timeoutMs)

  try {
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (timedOut) {
      return { status: 'error', reason: 'timeout', details: command }
    }
    if (exitCode === 0) return { status: 'pass' }

    const merged = (stdoutText + stderrText).split('\n')
    const tail = merged.slice(Math.max(0, merged.length - TAIL_LINES))
    return { status: 'fail', failedCommand: command, exitCode, tail }
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun test tests/verification.test.ts 2>&1 | tail -10
```

Expected: 16 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/verification.ts tests/verification.test.ts
git commit -m "feat(verification): SIGKILL commands exceeding timeoutMs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: CWD, CI env, already-running guard

**Files:**
- Modify: `tests/verification.test.ts`

(no implementation change — CWD and env are already wired; this task verifies and adds the concurrency test. The `run()` method already has the guarded `Set`, so already-running works once we assert it.)

- [ ] **Step 1: Add tests**

Append to the runner describe:

```typescript
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
```

Add `readFileSync` to the fs import.

- [ ] **Step 2: Implement already-running short-circuit**

The current `run()` adds to the set **after** the session lookup and then does work. We need to short-circuit when already running, BEFORE the try/finally wraps. Modify `src/verification.ts`:

Replace the `run` method body (the Set interaction) with:

```typescript
async run(sessionPath: string): Promise<VerificationResult> {
  if (this.running.has(sessionPath)) {
    return { status: 'error', reason: 'already-running', details: sessionPath }
  }

  const session = this.deps.registry.get(sessionPath)
  if (!session) {
    return { status: 'error', reason: 'spawn-failed', details: 'session not registered' }
  }

  this.running.add(sessionPath)
  try {
    const commands = this.resolveCommands(session.appliedProfile, session.path)
    if (commands.length === 0) {
      return { status: 'error', reason: 'no-commands', details: session.name }
    }

    for (const cmd of commands) {
      const res = await this.execOne(cmd, session.path)
      if (res.status !== 'pass') return res
    }
    return { status: 'pass' }
  } finally {
    this.running.delete(sessionPath)
  }
}
```

- [ ] **Step 3: Run tests — expect PASS**

```bash
bun test tests/verification.test.ts 2>&1 | tail -10
```

Expected: 19 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/verification.ts tests/verification.test.ts
git commit -m "feat(verification): already-running guard; CWD/env asserted in tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Probe fallback + `no-commands` path

**Files:**
- Modify: `tests/verification.test.ts`

(no implementation change — covered by Task 2's `resolveCommands`; this adds the missing test cases.)

- [ ] **Step 1: Add tests**

Append to the runner describe:

```typescript
test('probe fallback fires when profile commands are empty', async () => {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'echo ok' } }),
  )
  registry.register(dir, { appliedProfile: 'test-profile' })
  const called: string[] = []
  const runner = new VerificationRunner({
    registry,
    profiles: () => profiles({ verification: { commands: [] } }),
    probe: (p) => {
      called.push(p)
      return ['echo probed']
    },
  })
  const result = await runner.run(dir)
  expect(result.status).toBe('pass')
  expect(called).toEqual([dir])
})

test('no commands + empty probe → error(no-commands)', async () => {
  registry.register(dir, { appliedProfile: 'test-profile' })
  const runner = new VerificationRunner({
    registry,
    profiles: () => profiles({ verification: { commands: [] } }),
    probe: () => [],
  })
  const result = await runner.run(dir)
  expect(result.status).toBe('error')
  if (result.status === 'error') {
    expect(result.reason).toBe('no-commands')
  }
})
```

- [ ] **Step 2: Run tests — expect PASS**

```bash
bun test tests/verification.test.ts 2>&1 | tail -10
```

Expected: 21 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/verification.test.ts
git commit -m "test(verification): probe fallback and no-commands error

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Built-in profile verification defaults

**Files:**
- Modify: `src/profiles.ts`

Built-ins today are `careful`, `tdd`, `docs`, `yolo`. Only `careful` and `tdd` get verification defaults (the spec's "Built-In Profile Defaults" table).

- [ ] **Step 1: Add `verification` to the `careful` profile**

In `src/profiles.ts`, find the `careful` profile object (starts with `name: 'careful'`). It currently ends with:

```typescript
    driftDetection: true,
    sidecarEnabled: false,
  },
```

Change that ending to:

```typescript
    driftDetection: true,
    sidecarEnabled: false,
    verification: { commands: ['bun test', 'bunx tsc --noEmit'] },
  },
```

- [ ] **Step 2: Add `verification` to the `tdd` profile**

Same edit on the `tdd` profile object. Its current tail:

```typescript
    driftDetection: true,
    sidecarEnabled: false,
  },
```

becomes:

```typescript
    driftDetection: true,
    sidecarEnabled: false,
    verification: { commands: ['bun test', 'bunx tsc --noEmit'] },
  },
```

Leave `docs` and `yolo` untouched — both keep empty/missing `verification`, which means probe-fallback decides what to run.

- [ ] **Step 3: Verify compile and tests**

```bash
bunx tsc --noEmit 2>&1 | tail -5
bun test 2>&1 | tail -5
```

Expected: types check clean, all previously-passing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/profiles.ts
git commit -m "feat(profiles): default verification commands for tdd and careful

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Wire `VerificationRunner` into daemon

**Files:**
- Modify: `src/daemon.ts`
- Modify: `src/frontends/telegram.ts`

- [ ] **Step 1: Add runner construction to daemon**

In `src/daemon.ts`, add an import near the other local imports:

```typescript
import { VerificationRunner } from './verification'
```

After the line that declares `profiles` / `getProfiles`, add:

```typescript
const verificationRunner = new VerificationRunner({
  registry,
  profiles: getProfiles,
})
```

(`registry` is already constructed in `daemon.ts` earlier — place this line **after** the `registry` and `getProfiles` are in scope.)

- [ ] **Step 2: Extend `TelegramFrontendDeps` with the runner**

In `src/frontends/telegram.ts`, add `verificationRunner` to `TelegramFrontendDeps`:

```typescript
export type TelegramFrontendDeps = {
  token: string
  registry: SessionRegistry
  router: MessageRouter
  permissions: PermissionEngine
  screenManager: ScreenManager
  socketServer: SocketServer
  allowFrom: string[]
  taskMonitor: TaskMonitor | null
  verificationRunner: VerificationRunner
}
```

Add the import at the top of the file:

```typescript
import { VerificationRunner } from '../verification'
```

Add a corresponding private field in the class and assign it in the constructor:

```typescript
private verificationRunner: VerificationRunner
// ...
this.verificationRunner = deps.verificationRunner
```

- [ ] **Step 3: Pass the runner from daemon into telegram**

In `src/daemon.ts`, find the `new TelegramFrontend({ ... })` call and add `verificationRunner` to the deps object.

- [ ] **Step 4: Verify compile**

```bash
bunx tsc --noEmit 2>&1 | tail -5
bun test 2>&1 | tail -5
```

Expected: no type errors; all tests still pass (no functional change yet for `/verify`).

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts src/frontends/telegram.ts
git commit -m "feat(daemon): wire VerificationRunner into TelegramFrontend deps

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `/verify` command handler

**Files:**
- Modify: `src/frontends/telegram.ts`

- [ ] **Step 1: Add the `/verify` command**

In `src/frontends/telegram.ts`, inside `registerHandlers()` near the other session-scoped commands (e.g. after `/channel`), add:

```typescript
// /verify <session>
bot.command('verify', async (ctx) => {
  if (!this.isAllowed(ctx)) return
  const sessionName = (ctx.match ?? '').trim()
  if (!sessionName) {
    await ctx.reply('Usage: /verify <session>')
    return
  }
  const path = this.registry.findByName(sessionName)
  if (!path) {
    await ctx.reply(`Session "${sessionName}" not found`)
    return
  }

  const result = await this.verificationRunner.run(path)
  await this.sendVerificationResult(ctx, sessionName, result)
})
```

- [ ] **Step 2: Add the formatter as a method**

Still in `src/frontends/telegram.ts`, add a new private method on the class (near `deliverPermissionRequest`):

```typescript
private async sendVerificationResult(
  ctx: { reply: (text: string, opts?: any) => Promise<any> },
  sessionName: string,
  result: VerificationResult,
): Promise<void> {
  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  switch (result.status) {
    case 'pass':
      await ctx.reply('✅')
      return
    case 'fail': {
      const text =
        `❌ <b>${escapeHtml(sessionName)}</b> — ` +
        `<code>${escapeHtml(result.failedCommand)}</code> (exit ${result.exitCode})\n\n` +
        `<pre>${escapeHtml(result.tail.join('\n'))}</pre>`
      await ctx.reply(text, { parse_mode: 'HTML' })
      return
    }
    case 'error':
      switch (result.reason) {
        case 'timeout':
          await ctx.reply(`⏱ ${sessionName} — "${result.details}" exceeded 120s`)
          return
        case 'no-commands':
          await ctx.reply(
            `⚠️ ${sessionName} has no verification commands. ` +
            `Set them on the profile or add scripts to package.json.`,
          )
          return
        case 'already-running':
          await ctx.reply(`⏳ Verification already running for ${sessionName}`)
          return
        case 'spawn-failed':
          await ctx.reply(`⚠️ ${sessionName}: ${result.details}`)
          return
      }
  }
}
```

Add `VerificationResult` to the imports at the top:

```typescript
import { VerificationRunner, type VerificationResult } from '../verification'
```

- [ ] **Step 3: Register `/verify` in the command menu**

Still in `src/frontends/telegram.ts`, find the `commands` array inside `start()` and append:

```typescript
{ command: 'verify',   description: 'Run verification commands: <session>' },
```

- [ ] **Step 4: Verify compile + tests**

```bash
bunx tsc --noEmit 2>&1 | tail -5
bun test 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/frontends/telegram.ts
git commit -m "feat(telegram): /verify command with status-aware formatter

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Integration test — `sendVerificationResult` contract

**Files:**
- Modify: `tests/integration.test.ts`

Because directly hitting grammy's command dispatch requires setting up a mock Telegram transport, this task tests the **formatter** (the code that decides what message to send) rather than driving the command through the bot. The formatter is the single most valuable surface to lock down, and it's the one piece that would regress silently if we changed the message copy.

- [ ] **Step 1: Expose `sendVerificationResult` for testing via a narrow export**

In `src/frontends/telegram.ts`, export a stand-alone pure function that mirrors the formatter, and have the class method delegate to it. Replace the method body with a delegation to the exported function:

```typescript
// Add at the top level of the file, outside the class:
export async function renderVerificationResult(
  reply: (text: string, opts?: any) => Promise<any>,
  sessionName: string,
  result: VerificationResult,
): Promise<void> {
  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  switch (result.status) {
    case 'pass':
      await reply('✅')
      return
    case 'fail': {
      const text =
        `❌ <b>${escapeHtml(sessionName)}</b> — ` +
        `<code>${escapeHtml(result.failedCommand)}</code> (exit ${result.exitCode})\n\n` +
        `<pre>${escapeHtml(result.tail.join('\n'))}</pre>`
      await reply(text, { parse_mode: 'HTML' })
      return
    }
    case 'error':
      switch (result.reason) {
        case 'timeout':
          await reply(`⏱ ${sessionName} — "${result.details}" exceeded 120s`)
          return
        case 'no-commands':
          await reply(
            `⚠️ ${sessionName} has no verification commands. ` +
            `Set them on the profile or add scripts to package.json.`,
          )
          return
        case 'already-running':
          await reply(`⏳ Verification already running for ${sessionName}`)
          return
        case 'spawn-failed':
          await reply(`⚠️ ${sessionName}: ${result.details}`)
          return
      }
  }
}
```

Update the class method to delegate:

```typescript
private async sendVerificationResult(
  ctx: { reply: (text: string, opts?: any) => Promise<any> },
  sessionName: string,
  result: VerificationResult,
): Promise<void> {
  await renderVerificationResult(ctx.reply.bind(ctx), sessionName, result)
}
```

- [ ] **Step 2: Add tests for the formatter**

Append to `tests/integration.test.ts` inside the existing describe block:

```typescript
import { renderVerificationResult } from '../src/frontends/telegram'
import type { VerificationResult } from '../src/verification'

test('renderVerificationResult: pass sends ✅', async () => {
  const calls: Array<{ text: string; opts?: any }> = []
  const reply = async (text: string, opts?: any) => {
    calls.push({ text, opts })
  }
  const result: VerificationResult = { status: 'pass' }
  await renderVerificationResult(reply, 'myproj', result)
  expect(calls).toEqual([{ text: '✅', opts: undefined }])
})

test('renderVerificationResult: fail includes command, exit code, tail', async () => {
  const calls: Array<{ text: string; opts?: any }> = []
  const reply = async (text: string, opts?: any) => {
    calls.push({ text, opts })
  }
  const result: VerificationResult = {
    status: 'fail',
    failedCommand: 'bun test',
    exitCode: 2,
    tail: ['line1', 'line2'],
  }
  await renderVerificationResult(reply, 'myproj', result)
  expect(calls.length).toBe(1)
  expect(calls[0].text).toContain('myproj')
  expect(calls[0].text).toContain('bun test')
  expect(calls[0].text).toContain('exit 2')
  expect(calls[0].text).toContain('line1')
  expect(calls[0].text).toContain('line2')
  expect(calls[0].opts?.parse_mode).toBe('HTML')
})

test('renderVerificationResult: timeout, no-commands, already-running, spawn-failed', async () => {
  const scenarios: Array<{ result: VerificationResult; mustContain: string }> = [
    {
      result: { status: 'error', reason: 'timeout', details: 'bun test' },
      mustContain: '120s',
    },
    {
      result: { status: 'error', reason: 'no-commands', details: 'myproj' },
      mustContain: 'no verification commands',
    },
    {
      result: { status: 'error', reason: 'already-running', details: '/x' },
      mustContain: 'already running',
    },
    {
      result: { status: 'error', reason: 'spawn-failed', details: 'session not registered' },
      mustContain: 'session not registered',
    },
  ]
  for (const { result, mustContain } of scenarios) {
    const calls: string[] = []
    await renderVerificationResult(async (t: string) => {
      calls.push(t)
    }, 'myproj', result)
    expect(calls[0]).toContain(mustContain)
  }
})
```

- [ ] **Step 3: Run tests**

```bash
bun test 2>&1 | tail -10
```

Expected: all tests pass, with ~3 new integration tests.

- [ ] **Step 4: Commit**

```bash
git add src/frontends/telegram.ts tests/integration.test.ts
git commit -m "test(integration): verification result formatter contract

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Documentation updates (README, CLAUDE.md, CHANGELOG)

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Create or modify: `CHANGELOG.md`

- [ ] **Step 1: README update**

In `README.md`, inside the Telegram commands table, add a row:

```markdown
| `/verify <name>` | Run the session's verification commands (tests, typecheck, lint) |
```

Then add a new subsection titled `### Verification` directly under the "Telegram Bot Commands" block with this text:

```markdown
### Verification

Running `/verify <session>` executes the session's profile-defined verification commands against the session's project directory. If the applied profile has no commands, the runner auto-detects them from the project's `package.json` scripts (`test`, `typecheck`, `lint`).

Commands run sequentially and stop on the first failure. You get `✅` back on success, or a failure message containing the failed command, exit code, and the last 20 lines of merged stdout/stderr on failure. Per-command timeout is 120 seconds.

Built-in profiles with defaults:
- **careful** — `bun test`, `bunx tsc --noEmit`
- **tdd** — `bun test`, `bunx tsc --noEmit`
- **docs** / **yolo** — no commands (probe decides from `package.json`)
```

- [ ] **Step 2: CLAUDE.md update**

In `CLAUDE.md`:

1. Add a new entry to the Telegram Bot Commands list:
   ```markdown
   - `/verify <name>` — run the session's verification commands
   ```
2. In the "Key Design Decisions" block near the bottom, add a bullet:
   ```markdown
   - **Verification runner** — `src/verification.ts` spawns `bash -c "<cmd>"` per profile-defined command with a 120s timeout, CWD set to the session's project path, `CI=true` in env. Single concurrent run per session; silent on success; 20-line tail on failure.
   ```
3. Update the File Structure block under `src/` to include:
   ```
   verification.ts        # Subprocess-based verification runner + package.json probe
   ```

- [ ] **Step 3: Create or update CHANGELOG.md**

If `CHANGELOG.md` doesn't exist in the repo root, create it with this content:

```markdown
# Changelog

## Unreleased

### Added
- Sub-phase 1d: verification runner. New `/verify <session>` Telegram command runs profile-defined verification commands (or auto-detected `package.json` scripts) in the session's project directory. Silent on success, detailed failure report with exit code and 20-line output tail. Per-command 120s timeout, single concurrent run per session.
- Built-in profiles `tdd` and `careful` gain default verification commands (`bun test`, `bunx tsc --noEmit`).
```

If a `CHANGELOG.md` already exists, append the same entries under an `## Unreleased` heading, creating that heading if needed.

- [ ] **Step 4: Verify the full suite is still green**

```bash
bun test 2>&1 | tail -5
bunx tsc --noEmit 2>&1 | tail -5
```

Expected: all tests pass; type check clean.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md CHANGELOG.md
git commit -m "docs: verification runner in README, CLAUDE.md, CHANGELOG

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final check

After Task 11, the tree should be clean with all tests and types passing. Verify with:

```bash
git status
bun test 2>&1 | tail -5
bunx tsc --noEmit 2>&1 | tail -5
```

Push the branch:

```bash
git push
```
