// src/permission-engine.ts
import type { SessionRegistry } from './session-registry'
import type { PermissionRequest, PermissionResponse } from './types'

type PermissionInput = {
  requestId: string
  toolName: string
  description: string
  inputPreview: string
}

type PendingPermission = {
  sessionPath: string
  requestId: string
}

export class PermissionEngine {
  private registry: SessionRegistry
  private onForward: (req: PermissionRequest) => void
  private pending = new Map<string, PendingPermission>()

  constructor(
    registry: SessionRegistry,
    onForward: (req: PermissionRequest) => void,
  ) {
    this.registry = registry
    this.onForward = onForward
  }

  handle(sessionPath: string, input: PermissionInput): PermissionResponse | null {
    const session = this.registry.get(sessionPath)
    if (!session) return null

    if (session.trust === 'auto') {
      return { requestId: input.requestId, behavior: 'allow' }
    }

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
