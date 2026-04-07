// src/analysis.ts — pure functions for permission classification and drift detection
import type { Category } from './types'

// Tools that are always safe — auto-allow without prompting
const SILENT_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'TodoWrite',
  'TaskOutput',
  'WebFetch',
  'WebSearch',
  'NotebookRead',
])

// Dangerous command patterns — conservative, high-confidence only
const DANGEROUS_PATTERNS: RegExp[] = [
  // rm targeting system/home paths (allow /tmp, /var/tmp)
  /\brm\s+(-[rRf]+\s+)+(\/(?!tmp\b|var\/tmp\b)[\w-]+|~|\$HOME)/,
  // sudo with destructive commands
  /\bsudo\s+(rm|dd|mkfs|chmod|chown|shutdown|reboot|halt|init\s+0)/,
  // Recursive world-writable
  /\bchmod\s+(-R\s+)?777\b/,
  // Force push and hard reset to remote
  /\bgit\s+push\s+([^|]*\s)?(-f\b|--force(-with-lease)?\b)/,
  /\bgit\s+reset\s+--hard\s+(origin|upstream|remotes)/,
  // SQL destructive
  /\b(drop|truncate)\s+(table|database|schema)\b/i,
  // Filesystem nukes
  /\bmkfs\./,
  /\bdd\s+.*\bof=\/dev\/(sd|nvme|hd|mmcblk)/,
  // Pipe to shell
  /\b(curl|wget)\s+[^|]*\|\s*(bash|sh|zsh)\b/,
  // Raw device writes
  />\s*\/dev\/(sd|nvme|hd|mmcblk)/,
]

const BENIGN_FIRST_TOKENS = new Set([
  'ls', 'cat', 'echo', 'pwd', 'whoami', 'which', 'grep', 'find',
  'head', 'tail', 'file', 'stat', 'wc', 'sort', 'uniq', 'tr',
  'date', 'uptime', 'env', 'printenv', 'ps', 'df', 'du', 'free',
  'pytest',
])

const BENIGN_FIRST_TWO = new Set([
  'git status', 'git log', 'git diff', 'git branch', 'git show',
  'git blame', 'git remote', 'git tag',
  'npm test', 'npm run', 'npm ls', 'npm list',
  'cargo test', 'cargo check', 'cargo build', 'cargo clippy',
  'go test', 'go build', 'go vet',
  'bun test', 'bun run',
  'python -m',
])

export function classify(
  tool: string,
  args: Record<string, unknown>,
  projectPath: string,
): Category {
  // L1: Static map of always-safe tools
  if (SILENT_TOOLS.has(tool)) return 'silent'

  // L2 stubs — implemented in later tasks
  if (tool === 'Bash') return classifyBash(args, projectPath)
  if (tool === 'Write') return classifyWrite(args, projectPath)
  if (tool === 'Edit' || tool === 'MultiEdit') return classifyEdit(args, projectPath)

  // Unknown tools default to review (escalate to user)
  return 'review'
}

function classifyBash(args: Record<string, unknown>, _projectPath: string): Category {
  const command = String(args.command ?? '').trim()

  // Dangerous patterns first
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return 'dangerous'
  }

  // Composite commands (chained, piped, substituted) → review
  if (/[;&|`$()]/.test(command)) {
    return 'review'
  }

  // Benign first-token match
  const tokens = command.split(/\s+/)
  const firstToken = tokens[0] ?? ''
  if (BENIGN_FIRST_TOKENS.has(firstToken)) return 'logged'

  // Benign two-token combinations like "git status"
  if (tokens.length >= 2) {
    const firstTwo = `${tokens[0]} ${tokens[1]}`
    if (BENIGN_FIRST_TWO.has(firstTwo)) return 'logged'
  }

  return 'review'
}

function classifyWrite(args: Record<string, unknown>, projectPath: string): Category {
  const filePath = String(args.file_path ?? '')
  if (!filePath) return 'review'
  return isInsideProject(filePath, projectPath) ? 'logged' : 'review'
}

function classifyEdit(args: Record<string, unknown>, projectPath: string): Category {
  const filePath = String(args.file_path ?? '')
  if (!filePath) return 'review'
  return isInsideProject(filePath, projectPath) ? 'logged' : 'review'
}

function isInsideProject(filePath: string, projectPath: string): boolean {
  if (!projectPath) return false
  const normalized = projectPath.endsWith('/') ? projectPath : projectPath + '/'
  return filePath === projectPath || filePath.startsWith(normalized)
}
