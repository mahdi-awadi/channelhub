# Verification Runner — Design Spec

## Overview

A subprocess-based verification runner that executes project-defined commands (tests, typecheck, lint) against a session's project directory on user-triggered `/verify`. Deterministic, no LLM in the critical path. Sub-phase of Phase 1: Smart Sessions.

## Problem

Rules and facts (shipped in sub-phase 1c) tell Claude *what* to do, but give the user no automated way to check whether it actually did. A user pinging "is the build still green?" from their phone currently requires either attaching to the tmux session or asking Claude directly — both of which defeat the point of a remote control channel.

## Solution

A `VerificationRunner` class in `src/verification.ts` that runs a session's verification commands sequentially, stops on the first failure, and reports the failing command + last 20 lines of merged stdout/stderr back through the existing Telegram frontend. Silent on success, specific on failure.

## Scope

**In scope:**
- Manual trigger via `/verify <session>` Telegram command
- Command source: applied profile's `verification.commands`, falling back to auto-detect from `package.json` scripts
- Sequential execution, stop on first non-zero exit
- Per-command 120-second timeout with SIGKILL on expiry
- Single concurrent run per session (queued second requests return "already running")
- Unlimited concurrent runs across different sessions
- Failure notification: exit code, failed command, 20-line tail of merged output
- Built-in profile defaults (`tdd`, `careful`, `default`) updated with sensible commands
- README / CLAUDE.md / CHANGELOG updates

**Out of scope (deferred):**
- Idle-based auto-trigger (the "B later" option from brainstorming) — separate design when ready
- LLM sidecar module that reacts to failures — dropped per brainstorming decision
- Profile-create UX for editing `verification` config from Telegram — built-in defaults + manual JSON edit cover the common case
- Full-log attachments via `📎 Full log` button — 20-line tail is sufficient for the first cut
- Web UI mirror of `/verify` — add `POST /api/verify` once we have feedback on the Telegram flow

## Architecture

One new module: **`src/verification.ts`**.

```
┌──────────────────────────────────────────────────────────┐
│                         daemon.ts                         │
│  const runner = new VerificationRunner({ registry,       │
│                                          profiles })      │
│  // pass into TelegramFrontend deps                       │
└──────────────────────────────────────────────────────────┘
                               ↓
┌──────────────────────────────────────────────────────────┐
│                    telegram.ts (/verify)                  │
│  const result = await runner.run(sessionPath)             │
│  → format result → sendMessage / react                    │
└──────────────────────────────────────────────────────────┘
                               ↓
┌──────────────────────────────────────────────────────────┐
│                     verification.ts                       │
│  VerificationRunner                                       │
│    .run(path): resolve commands → spawn → wait → result   │
│    .isRunning(path): bool                                 │
│  probeProject(projectPath): string[]                      │
└──────────────────────────────────────────────────────────┘
                               ↓
                    Bun.spawn('bash', ['-c', cmd])
                    cwd = session.projectPath
                    env = { ...process.env, CI: 'true' }
```

## Public API

```ts
// src/verification.ts

export type VerificationResult =
  | { status: 'pass' }
  | { status: 'fail'; failedCommand: string; exitCode: number; tail: string[] }
  | {
      status: 'error'
      reason: 'timeout' | 'no-commands' | 'spawn-failed' | 'already-running'
      details: string
    }

export interface VerificationRunnerDeps {
  registry: SessionRegistry
  profiles: () => Profile[]   // callable so reloaded profiles are seen
  probe?: (projectPath: string) => string[]  // injectable for tests
  timeoutMs?: number          // default 120_000
}

export class VerificationRunner {
  constructor(deps: VerificationRunnerDeps)
  async run(sessionPath: string): Promise<VerificationResult>
  isRunning(sessionPath: string): boolean
}

export function probeProject(projectPath: string): string[]
```

## Data Model

No new types added. The existing `Profile.verification.commands: string[]` field
(already in `src/types.ts`) is the source of truth.

**Empty-array semantics:** if a session's effective profile has
`verification.commands: []`, the runner falls back to `probeProject`.
If both are empty, the result is `{ status: 'error', reason: 'no-commands' }`.

## Command Sourcing

1. **Profile first** — `resolveSession(...)` materializes `verification.commands` from the applied profile + session overrides.
2. **Probe fallback** — if profile commands are empty, call `probeProject(projectPath)`.
3. **Probe logic** — read `<projectPath>/package.json`, inspect `.scripts`:
   - `scripts.test` → `bun run test`
   - `scripts.typecheck` OR a standalone `tsc` mention → `bunx tsc --noEmit`
   - `scripts.lint` → `bun run lint`
4. Probe returns a deduped ordered list. If no `package.json` or no matching scripts, probe returns `[]`.

Probe is **not** persisted back to config — it runs fresh each invocation. Users who want stable commands set them on the profile.

## Runner Lifecycle

Per `run(sessionPath)`:

1. **Already-running check** — if `sessionPath` is in the internal `Set<string>`, return `{ status: 'error', reason: 'already-running', details: sessionPath }` immediately.
2. **Resolve session** — `registry.get(sessionPath)`; if missing, return `spawn-failed` with "session not registered".
3. **Resolve commands** — profile's `verification.commands` → fallback to `probeProject(session.path)`. If empty, return `no-commands`.
4. **Mark running** — add to Set.
5. **Sequential execution** — for each command:
   - `Bun.spawn(['bash', '-c', cmd], { cwd: projectPath, env: { ...process.env, CI: 'true' }, stdout: 'pipe', stderr: 'pipe' })`.
   - Merge stdout+stderr into a single rolling buffer (keep last 200 lines in memory, slice last 20 for the tail).
   - `setTimeout(() => child.kill('SIGKILL'), timeoutMs)` starts on spawn.
   - `await child.exited` — if non-zero, return `fail` with that command, exit code, tail.
   - If the timeout fired, return `error(timeout)`.
   - Clear the timeout on clean exit.
6. **All passed** — return `{ status: 'pass' }`.
7. **`finally`** — remove sessionPath from Set.

Output buffering uses a bounded ring — the last 200 lines — so a 10-minute CI log can't exhaust memory.

## Telegram Formatter

`/verify <session>` handler:

```ts
bot.command('verify', async (ctx) => {
  if (!isAllowed(ctx)) return
  const sessionName = (ctx.match ?? '').trim()
  if (!sessionName) { await ctx.reply('Usage: /verify <session>'); return }
  const path = registry.findByName(sessionName)
  if (!path) { await ctx.reply(`Session "${sessionName}" not found`); return }

  const result = await runner.run(path)
  switch (result.status) {
    case 'pass':
      // Minimal happy-path signal: a ✅ reply. A proper message
      // reaction via bot.api.setMessageReaction is a later polish —
      // dependent on the installed grammy version — but a one-char
      // reply is unambiguous and works today.
      await ctx.reply('✅')
      return
    case 'fail':
      await ctx.reply(
        `❌ <b>${sessionName}</b> — <code>${escape(result.failedCommand)}</code> (exit ${result.exitCode})\n\n` +
        `<pre>${escape(result.tail.join('\n'))}</pre>`,
        { parse_mode: 'HTML' },
      )
      return
    case 'error':
      const msg =
        result.reason === 'timeout'      ? `⏱ ${sessionName} — "${result.details}" exceeded 120s` :
        result.reason === 'no-commands'  ? `⚠️ ${sessionName} has no verification commands. Set them on the profile or add scripts to package.json.` :
        result.reason === 'already-running' ? `⏳ Verification already running for ${sessionName}` :
        `⚠️ ${sessionName}: ${result.details}`
      await ctx.reply(msg)
      return
  }
})
```

The `ctx.react('✅')` is the "done" signal for the happy path — no new message, no noise.

## Built-In Profile Defaults

Existing built-ins in `src/profiles.ts` gain sensible `verification.commands`:

| Profile     | Commands                                     |
| ----------- | -------------------------------------------- |
| `default`   | `[]` (probe decides)                         |
| `tdd`       | `["bun test", "bunx tsc --noEmit"]`          |
| `careful`   | `["bun test", "bunx tsc --noEmit"]`          |
| `yolo`      | `[]` (verification disabled in spirit)       |

The existing `VerificationConfig` type in `src/types.ts` is reused as-is
(fields: `commands: string[]`, plus optional `sentinelPhrase` and
`timeoutSec` that are ignored in this pass). No "enabled" flag —
empty `commands` plus empty probe result is the no-op state.

## Error Handling

| Failure                                              | Result                                              | User sees                                        |
| ---------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| Session not in registry                              | `error(spawn-failed)`                               | `⚠️ <name>: session not registered`              |
| No commands in profile and no scripts in `package.json` | `error(no-commands)`                             | `⚠️ <name> has no verification commands…`        |
| Command exits non-zero                               | `fail`                                              | Red-X message with command + exit code + tail    |
| Command exceeds 120s                                 | `error(timeout)`                                    | `⏱ <name> — "<cmd>" exceeded 120s`               |
| `Bun.spawn` throws                                   | `error(spawn-failed)`                               | `⚠️ <name>: <error message>`                     |
| Second `/verify` while one is in flight              | `error(already-running)`                            | `⏳ Verification already running for <name>`     |

## Testing Plan

New file: **`tests/verification.test.ts`**. All tests use fast subprocess commands (`echo`, `true`, `false`, `sleep 0.01`) so the full suite stays under 1s overhead.

**Unit coverage:**
- `probeProject`:
  - `package.json` with `test` script → returns `["bun run test"]`
  - With `test` + `typecheck` → returns both in order
  - With standalone `tsc` script value → suggests `bunx tsc --noEmit`
  - Missing `package.json` → `[]`
  - `scripts` missing or empty → `[]`
- `VerificationRunner`:
  - Happy path — `echo ok` → `{ status: 'pass' }`
  - Failure — `false` → `fail` with exit code 1 and tail containing some output
  - Stops on first failure — `[false, touch sentinel]` never creates the sentinel file
  - Timeout — `sleep 5` with `timeoutMs: 100` → `error(timeout)`
  - Respects CWD — command asserts `pwd === projectPath`
  - `CI=true` env propagates — command echoes `$CI` and verification captures it
  - `isRunning()` is true during the spawn window, false after `run()` resolves
  - Second `run()` for same session mid-flight returns `error(already-running)`
  - Probe fallback fires when profile commands are `[]`
  - `error(no-commands)` when both profile and probe are empty

**Integration coverage (append to `tests/integration.test.ts`):**
- End-to-end `/verify` call: register session → set a profile with `commands: ["echo ok"]` → simulate Telegram `/verify` via a mocked grammy context → assert the context's `reply` was called with `'✅'`. Failure path similarly asserts `reply` was called with a string containing the failed command name and the exit code.

**Regression:** full `bun test` must stay at 169 + new-count passing. Target ~185 tests after this sub-phase.

## File Changes

| File                                        | Change                                                  |
| ------------------------------------------- | ------------------------------------------------------- |
| `src/verification.ts`                       | **new** — runner + probe                                |
| `src/profiles.ts`                           | add `verification.commands` to built-in profiles        |
| `src/daemon.ts`                             | construct `VerificationRunner`, pass to Telegram deps   |
| `src/frontends/telegram.ts`                 | add `/verify` command + formatter; register in menu     |
| `tests/verification.test.ts`                | **new** — unit tests                                    |
| `tests/integration.test.ts`                 | append end-to-end `/verify` test                        |
| `README.md`                                 | document `/verify` and profile verification config      |
| `CLAUDE.md`                                 | mention runner in architecture + key design decisions   |
| `CHANGELOG.md`                              | entry for sub-phase 1d                                  |

## Security

- `bash -c "<command>"` interpolates the command string directly. The command comes from the profile (user-controlled) or `package.json` scripts (also user-controlled — they chose to trust their own project). No external/network input reaches the shell. Acceptable for a local-machine tool.
- Timeout + SIGKILL prevents runaway commands consuming the daemon's process table forever.
- Env is inherited, not whitelisted — consistent with `screen-manager.ts` (which also inherits env for Claude sessions). A stricter env model is future work.

## Migration

None. `verification.commands` already exists in the type; empty arrays on existing profiles stay empty (probe fallback handles it). No persisted-data changes.

## Open Questions (resolved during brainstorming)

- **Auto-trigger?** No for this pass. Idle-based (Q2 option B) is a separate spec.
- **Sidecar / LLM involvement?** No — Runner-only per Q1.
- **Success notification?** No — silent per Q5.
- **Parallel commands?** No — sequential with stop-on-first-fail per Q6.
- **Full-log attachment?** No — 20-line tail per Q4; promote to `📎 Full log` button if users ask.
