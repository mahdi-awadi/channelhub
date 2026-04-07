// src/task-monitor.ts
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { EventEmitter } from 'events'

export type AgentTask = {
  id: string
  subject: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed'
  owner?: string
  blockedBy?: string[]
}

export function parseTaskFile(content: string): AgentTask {
  const raw = JSON.parse(content)
  return {
    id: String(raw.id ?? ''),
    subject: String(raw.subject ?? ''),
    description: raw.description ? String(raw.description) : undefined,
    status: raw.status ?? 'pending',
    owner: raw.owner ? String(raw.owner) : undefined,
    blockedBy: Array.isArray(raw.blockedBy) ? raw.blockedBy.map(String) : [],
  }
}

export class TaskMonitor extends EventEmitter {
  private basePath: string
  private pollInterval: ReturnType<typeof setInterval> | null = null

  constructor(basePath?: string) {
    super()
    this.basePath = basePath ?? join(homedir(), '.claude', 'tasks')
  }

  readTasks(teamName?: string): AgentTask[] {
    const tasks: AgentTask[] = []
    try {
      if (teamName) {
        return this.readTeamTasks(join(this.basePath, teamName))
      }
      const dirs = readdirSync(this.basePath, { withFileTypes: true })
      for (const dir of dirs) {
        if (dir.isDirectory()) {
          tasks.push(...this.readTeamTasks(join(this.basePath, dir.name)))
        }
      }
    } catch {}
    return tasks
  }

  private readTeamTasks(dir: string): AgentTask[] {
    const tasks: AgentTask[] = []
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.json'))
      for (const file of files) {
        try {
          const content = readFileSync(join(dir, file), 'utf8')
          tasks.push(parseTaskFile(content))
        } catch {}
      }
    } catch {}
    return tasks
  }

  readAllGrouped(): Record<string, AgentTask[]> {
    const result: Record<string, AgentTask[]> = {}
    try {
      const dirs = readdirSync(this.basePath, { withFileTypes: true })
      for (const dir of dirs) {
        if (dir.isDirectory()) {
          const tasks = this.readTeamTasks(join(this.basePath, dir.name))
          if (tasks.length > 0) {
            result[dir.name] = tasks
          }
        }
      }
    } catch {}
    return result
  }

  startPolling(intervalMs: number = 2000): void {
    this.stopPolling()
    let lastSnapshot = ''
    this.pollInterval = setInterval(() => {
      const tasks = this.readTasks()
      const snapshot = JSON.stringify(tasks)
      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot
        this.emit('tasks:updated', tasks)
      }
    }, intervalMs)
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }
}
