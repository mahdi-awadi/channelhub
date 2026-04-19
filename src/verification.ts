// src/verification.ts
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { SessionRegistry } from './session-registry'
import type { Profile, SessionState } from './types'
import { resolveSession } from './profiles'

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

const DEFAULT_TIMEOUT_MS = 120_000
const TAIL_LINES = 20

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
    if (this.running.has(sessionPath)) {
      return { status: 'error', reason: 'already-running', details: sessionPath }
    }

    const session = this.deps.registry.get(sessionPath)
    if (!session) {
      return { status: 'error', reason: 'spawn-failed', details: 'session not registered' }
    }

    this.running.add(sessionPath)
    try {
      const commands = this.resolveCommands(session, session.path)
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

  private resolveCommands(session: SessionState, projectPath: string): string[] {
    const effective = resolveSession(
      { appliedProfile: session.appliedProfile, profileOverrides: session.profileOverrides },
      this.deps.profiles(),
    )
    const fromProfile = effective.verification?.commands ?? []
    if (fromProfile.length > 0) return fromProfile
    return this.probeFn(projectPath)
  }

  private async execOne(command: string, cwd: string): Promise<VerificationResult> {
    const spawn = () =>
      Bun.spawn(['bash', '-c', command], {
        cwd,
        env: { ...process.env, CI: 'true' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn()
    } catch (err) {
      return {
        status: 'error',
        reason: 'spawn-failed',
        details: err instanceof Error ? err.message : String(err),
      }
    }

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
}
