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
