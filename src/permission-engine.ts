// src/permission-engine.ts
import type { SessionRegistry } from './session-registry'
import type { PermissionRequest, PermissionResponse, Category, TrustLevel } from './types'
import { classify } from './analysis'

type PermissionInput = {
  requestId: string
  toolName: string
  description: string
  inputPreview: string
  toolArgs?: Record<string, unknown>
}

type PendingPermission = {
  sessionPath: string
  requestId: string
}

export type ActivityEntry = {
  sessionName: string
  sessionPath: string
  timestamp: number
  toolName: string
  category: Category
  action: 'allowed' | 'escalated'
  inputPreview: string
}

function decideAction(category: Category, trust: TrustLevel): 'allow' | 'escalate' {
  if (category === 'silent') return 'allow'
  if (category === 'dangerous') return trust === 'yolo' ? 'allow' : 'escalate'
  if (category === 'logged') return trust === 'strict' ? 'escalate' : 'allow'
  if (category === 'review') return (trust === 'strict' || trust === 'ask') ? 'escalate' : 'allow'
  return 'escalate'
}

export class PermissionEngine {
  private registry: SessionRegistry
  private onForward: (req: PermissionRequest) => void
  private pending = new Map<string, PendingPermission>()
  private activityLog: ActivityEntry[] = []
  private readonly MAX_LOG_ENTRIES = 500

  constructor(
    registry: SessionRegistry,
    onForward: (req: PermissionRequest) => void,
  ) {
    this.registry = registry
    this.onForward = onForward
  }

  getActivity(): ActivityEntry[] {
    return [...this.activityLog]
  }

  private recordActivity(entry: ActivityEntry): void {
    this.activityLog.push(entry)
    if (this.activityLog.length > this.MAX_LOG_ENTRIES) {
      this.activityLog.shift()
    }
  }

  handle(sessionPath: string, input: PermissionInput): PermissionResponse | null {
    const session = this.registry.get(sessionPath)
    if (!session) return null

    // Strip the :index suffix to get the actual project folder
    const projectPath = sessionPath.replace(/:\d+$/, '')
    const category = classify(input.toolName, input.toolArgs ?? {}, projectPath)
    const action = decideAction(category, session.trust)

    if (category !== 'silent') {
      this.recordActivity({
        sessionName: session.name,
        sessionPath,
        timestamp: Date.now(),
        toolName: input.toolName,
        category,
        action: action === 'allow' ? 'allowed' : 'escalated',
        inputPreview: input.inputPreview.slice(0, 200),
      })
    }

    if (action === 'allow') {
      return { requestId: input.requestId, behavior: 'allow' }
    }

    // Escalate to user
    this.pending.set(input.requestId, { sessionPath, requestId: input.requestId })
    this.onForward({
      sessionName: session.name,
      requestId: input.requestId,
      toolName: input.toolName,
      description: input.description,
      inputPreview: input.inputPreview,
    })
    return null
  }

  resolve(requestId: string, behavior: 'allow' | 'deny'): { response: PermissionResponse; sessionPath: string } | null {
    const pending = this.pending.get(requestId)
    if (!pending) return null
    this.pending.delete(requestId)
    return { response: { requestId, behavior }, sessionPath: pending.sessionPath }
  }
}
