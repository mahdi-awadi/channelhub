// src/session-registry.ts
import { basename } from 'path'
import type { SessionState, SessionConfig, TrustLevel } from './types'

type RegistryOptions = {
  defaultTrust: TrustLevel
  defaultUploadDir: string
}

export class SessionRegistry {
  private sessions = new Map<string, SessionState>()
  private options: RegistryOptions

  constructor(options: RegistryOptions) {
    this.options = options
  }

  folderPath(sessionKey: string): string {
    const idx = sessionKey.lastIndexOf(':')
    if (idx > 0 && /^\d+$/.test(sessionKey.slice(idx + 1))) {
      return sessionKey.slice(0, idx)
    }
    return sessionKey
  }

  getTeam(folderPath: string): SessionState[] {
    return [...this.sessions.values()]
      .filter(s => this.folderPath(s.path) === folderPath)
      .sort((a, b) => (a.teamIndex ?? 0) - (b.teamIndex ?? 0))
  }

  getTeamLead(folderPath: string): SessionState | undefined {
    return this.getTeam(folderPath).find(s => s.teamIndex === 0)
  }

  nextTeamIndex(folderPath: string): number {
    const team = this.getTeam(folderPath)
    if (team.length === 0) return 0
    return Math.max(...team.map(s => s.teamIndex ?? 0)) + 1
  }

  register(path: string, overrides?: Partial<SessionConfig>): SessionState {
    if (this.sessions.has(path)) {
      throw new Error(`Session for ${path} already registered`)
    }
    const folder = this.folderPath(path)
    const baseName = overrides?.name ?? basename(folder)
    const name = this.uniqueName(baseName)
    const session: SessionState = {
      path,
      name,
      trust: overrides?.trust ?? this.options.defaultTrust,
      prefix: overrides?.prefix ?? '',
      uploadDir: overrides?.uploadDir ?? this.options.defaultUploadDir,
      managed: overrides?.managed ?? false,
      teamIndex: overrides?.teamIndex ?? 0,
      teamSize: overrides?.teamSize ?? 0,
      status: 'active',
      connectedAt: Date.now(),
    }
    this.sessions.set(path, session)
    return session
  }

  private uniqueName(base: string): string {
    const existing = new Set([...this.sessions.values()].map(s => s.name))
    if (!existing.has(base)) return base
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`
      if (!existing.has(candidate)) return candidate
    }
  }

  disconnect(path: string): void {
    const s = this.sessions.get(path)
    if (s) s.status = 'disconnected'
  }

  reconnect(path: string): void {
    const s = this.sessions.get(path)
    if (s) {
      s.status = 'active'
      s.connectedAt = Date.now()
    }
  }

  unregister(path: string): void {
    this.sessions.delete(path)
  }

  get(path: string): SessionState | undefined {
    return this.sessions.get(path)
  }

  list(): SessionState[] {
    return [...this.sessions.values()]
  }

  findByName(name: string): string | undefined {
    for (const [path, s] of this.sessions) {
      if (s.name === name) return path
    }
    return undefined
  }

  rename(path: string, newName: string): void {
    const s = this.sessions.get(path)
    if (s) s.name = newName
  }

  setTrust(path: string, trust: TrustLevel): void {
    const s = this.sessions.get(path)
    if (s) s.trust = trust
  }

  setPrefix(path: string, prefix: string): void {
    const s = this.sessions.get(path)
    if (s) s.prefix = prefix
  }

  restoreFrom(saved: Record<string, SessionConfig>): void {
    for (const [path, config] of Object.entries(saved)) {
      this.sessions.set(path, {
        ...config,
        path,
        status: 'disconnected',
        connectedAt: null,
      })
    }
  }

  toSaveFormat(): Record<string, SessionConfig> {
    const result: Record<string, SessionConfig> = {}
    for (const [path, s] of this.sessions) {
      result[path] = {
        name: s.name,
        trust: s.trust,
        prefix: s.prefix,
        uploadDir: s.uploadDir,
        managed: s.managed,
        teamIndex: s.teamIndex,
        teamSize: s.teamSize,
      }
    }
    return result
  }
}
