// src/types.ts

export type TrustLevel = 'strict' | 'ask' | 'auto' | 'yolo'

// Legacy value kept for migration — never written anywhere new
export type LegacyTrustLevel = 'ask' | 'auto-approve'

export type SessionStatus = 'active' | 'disconnected' | 'respawning'

export type Category = 'silent' | 'logged' | 'review' | 'dangerous'

export type FrontendSource = 'telegram' | 'web' | 'cli'

export type ChannelOverrides = Partial<Record<FrontendSource, string>>

export type VerificationConfig = {
  commands: string[]
  sentinelPhrase?: string   // default: "✅ COMPLETE"
  timeoutSec?: number        // default: 120
}

export type Profile = {
  name: string
  description?: string
  trust: TrustLevel
  rules: string[]
  facts: string[]
  prefix: string
  channelOverrides?: ChannelOverrides
  driftDetection?: boolean   // default: true
  sidecarEnabled?: boolean   // default: false
  verification?: VerificationConfig
}

export type ProfileOverrides = Partial<Omit<Profile, 'name' | 'description'>>

export type SessionConfig = {
  name: string
  trust: TrustLevel
  prefix: string
  uploadDir: string
  managed: boolean
  teamIndex: number       // 0 = lead or solo, 1+ = teammate
  teamSize: number        // 0 = solo, N = team of N
  appliedProfile?: string           // name of profile used at spawn
  profileOverrides?: ProfileOverrides // deltas from the profile
}

export type SessionState = SessionConfig & {
  path: string
  status: SessionStatus
  connectedAt: number | null
}

export type HubConfig = {
  webPort: number
  webHost?: string
  telegramToken: string
  telegramBotUsername?: string
  telegramAllowFrom: string[]
  defaultTrust: TrustLevel
  defaultUploadDir: string
}

export type InboundMessage = {
  sessionName: string
  text: string
  frontend: FrontendSource
  user: string
  files?: string[]
}

export type OutboundMessage = {
  sessionName: string
  text: string
  files?: string[]
}

export type PermissionRequest = {
  sessionName: string
  requestId: string
  toolName: string
  description: string
  inputPreview: string
}

export type PermissionResponse = {
  requestId: string
  behavior: 'allow' | 'deny'
}

// Wire protocol between shim and daemon over Unix socket.
// Each message is a newline-delimited JSON object.
export type ShimToDaemon =
  | { type: 'register'; cwd: string }
  | { type: 'tool_call'; name: string; arguments: Record<string, unknown> }
  | { type: 'permission_request'; requestId: string; toolName: string; description: string; inputPreview: string; toolArgs?: Record<string, unknown> }

export type DaemonToShim =
  | { type: 'registered'; sessionName: string }
  | { type: 'rejected'; reason: string }
  | { type: 'channel_message'; content: string; meta: Record<string, string> }
  | { type: 'tool_result'; name: string; result: unknown; isError?: boolean }
  | { type: 'permission_response'; requestId: string; behavior: 'allow' | 'deny' }

export function migrateTrustLevel(value: string): TrustLevel {
  if (value === 'auto-approve') return 'auto'
  if (value === 'strict' || value === 'ask' || value === 'auto' || value === 'yolo') {
    return value
  }
  return 'ask' // default fallback
}
