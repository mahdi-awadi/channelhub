// src/claude-sessions.ts — pure helpers over ~/.claude/projects/
import { homedir } from 'os'
import { join, resolve } from 'path'
import { readdir, stat, open } from 'fs/promises'

export const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')

/**
 * Encode a project cwd to Claude's storage directory name.
 * Claude stores conversations at ~/.claude/projects/<encoded>/<session-id>.jsonl,
 * where <encoded> is the absolute cwd with every '/' replaced by '-'.
 */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, '-')
}

/**
 * True iff `candidate` resolves to a path strictly inside PROJECTS_ROOT.
 * Rejects the root itself (must be a child).
 */
export function isInsideProjectsRoot(candidate: string): boolean {
  const resolved = resolve(candidate)
  const root = resolve(PROJECTS_ROOT) + '/'
  return resolved !== resolve(PROJECTS_ROOT) && resolved.startsWith(root)
}

const MAX_RESULTS = 10
const HEAD_BYTES = 4096
const PREVIEW_CHARS = 120

export type PriorSession = {
  id: string
  firstUserMessage: string
  mtime: number  // unix seconds
}

export type ListOptions = {
  rootOverride?: string  // for tests; defaults to PROJECTS_ROOT
}

export async function listPriorSessions(
  projectPath: string,
  opts: ListOptions = {}
): Promise<PriorSession[]> {
  const root = opts.rootOverride ?? PROJECTS_ROOT
  const storageDir = `${root}/${encodeProjectPath(projectPath)}`

  // Path-safety gate — production only. Tests use rootOverride and trust their own tmp dirs.
  if (!opts.rootOverride && !isInsideProjectsRoot(storageDir)) return []

  let entries: string[]
  try {
    entries = await readdir(storageDir)
  } catch {
    return []
  }

  const jsonl = entries.filter(e => e.endsWith('.jsonl'))
  const metadata: PriorSession[] = []

  for (const file of jsonl) {
    const full = `${storageDir}/${file}`
    try {
      const s = await stat(full)
      const firstUserMessage = await readFirstUserMessage(full)
      metadata.push({
        id: file.slice(0, -'.jsonl'.length),
        firstUserMessage,
        mtime: Math.floor(s.mtimeMs / 1000),
      })
    } catch {
      continue
    }
  }

  metadata.sort((a, b) => b.mtime - a.mtime)
  return metadata.slice(0, MAX_RESULTS)
}

async function readFirstUserMessage(file: string): Promise<string> {
  let handle
  try {
    handle = await open(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0)
    const text = buf.slice(0, bytesRead).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        const content = extractUserContent(obj)
        if (content != null) return content.slice(0, PREVIEW_CHARS)
      } catch { continue }
    }
    return '(no messages)'
  } finally {
    await handle?.close()
  }
}

function extractUserContent(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const msg = o.message as Record<string, unknown> | undefined
  const isUser = o.type === 'user' || o.role === 'user' || msg?.role === 'user'
  if (!isUser) return null
  const content = (msg?.content ?? o.content) as unknown
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string') {
        return (part as { text: string }).text
      }
    }
  }
  return null
}
