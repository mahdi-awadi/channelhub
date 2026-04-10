// src/daemon.ts
import { join } from 'path'
import { loadHubConfig, loadSessions, saveSessions, loadProfilesForHub, saveProfilesForHub, HUB_DIR } from './config'
import { SessionRegistry } from './session-registry'
import { SocketServer } from './socket-server'
import { PermissionEngine } from './permission-engine'
import { MessageRouter } from './message-router'
import { ScreenManager } from './screen-manager'
import { TaskMonitor } from './task-monitor'
import { TelegramFrontend } from './frontends/telegram'
import { WebFrontend } from './frontends/web'
import type { PermissionRequest, Profile, FrontendSource } from './types'
import { getProfile, resolveSession, injectContext } from './profiles'

const config = loadHubConfig()
const savedSessions = loadSessions()

let profiles: Profile[] = loadProfilesForHub()
process.stderr.write(`hub: loaded ${profiles.length} profiles\n`)

export function getProfiles(): Profile[] {
  return profiles
}

export function reloadProfiles(): void {
  profiles = loadProfilesForHub()
}

const SOCKET_PATH = process.env.HUB_SOCKET ?? join(HUB_DIR, 'hub.sock')

const SHIM_COMMAND = `bun run ${join(import.meta.dir, 'shim.ts')}`

// Session registry
const registry = new SessionRegistry({
  defaultTrust: config.defaultTrust,
  defaultUploadDir: config.defaultUploadDir,
})
registry.restoreFrom(savedSessions)

// Permission engine
let telegramFrontend: TelegramFrontend | null = null
let webFrontend: WebFrontend | null = null

const permissions = new PermissionEngine(registry, (req: PermissionRequest) => {
  telegramFrontend?.deliverPermissionRequest(req)
  webFrontend?.deliverPermissionRequest(req)
})

// Screen manager
const screenManager = new ScreenManager()

// Task monitor
const taskMonitor = new TaskMonitor()
taskMonitor.startPolling(2000)

taskMonitor.on('tasks:updated', () => {
  const grouped = taskMonitor.readAllGrouped()
  webFrontend?.deliverTaskUpdate(grouped)
})

// Socket server
const socketServer = new SocketServer(registry, SOCKET_PATH)

socketServer.onLookupProfile = (folder: string) => {
  const entry = screenManager.getManagedByPath(folder)
  if (!entry) return { managed: false }
  const profile = entry.profileName ? getProfile(entry.profileName, profiles) : undefined
  return { managed: true, profile }
}

// Message router
const router = new MessageRouter(
  registry,
  (path, content, meta) => {
    // Resolve effective session config and inject channel instructions,
    // rules, and facts based on the frontend that sent this message.
    const session = registry.get(path)
    let enrichedContent = content
    if (session) {
      const effective = resolveSession(
        { appliedProfile: session.appliedProfile, profileOverrides: session.profileOverrides },
        profiles,
      )
      const frontend = (meta.frontend ?? 'web') as FrontendSource
      enrichedContent = injectContext(content, frontend, effective)
    }
    return socketServer.sendToSession(path, {
      type: 'channel_message',
      content: enrichedContent,
      meta,
    })
  },
  (sessionName, text, files) => {
    telegramFrontend?.deliverToUser(sessionName, text, files)
    webFrontend?.deliverToUser(sessionName, text, files)
  },
)

// Wire socket server events
socketServer.on('session:connected', (path: string) => {
  process.stderr.write(`hub: session connected: ${path}\n`)
  saveSessions(registry.toSaveFormat())
  webFrontend?.refreshSessions()
})

socketServer.on('session:disconnected', (path: string) => {
  const session = registry.get(path)
  process.stderr.write(`hub: session disconnected: ${path}\n`)
  saveSessions(registry.toSaveFormat())
  webFrontend?.refreshSessions()

  if (session?.managed) {
    const s = registry.get(path)
    if (s) s.status = 'respawning'
    webFrontend?.refreshSessions()
    screenManager.scheduleRespawn(session.name)
  }
})

socketServer.on('tool_call', (path: string, name: string, args: Record<string, unknown>) => {
  const session = registry.get(path)
  if (!session) return

  if (name === 'reply') {
    const text = args.text as string
    const files = args.files as string[] | undefined
    router.routeFromSession(path, text, files)
    socketServer.sendToSession(path, {
      type: 'tool_result',
      name: 'reply',
      result: 'sent',
    })
  } else if (name === 'edit_message') {
    telegramFrontend?.deliverToUser(session.name, `(edited) ${args.text as string}`)
    webFrontend?.deliverToUser(session.name, `(edited) ${args.text as string}`)
    socketServer.sendToSession(path, {
      type: 'tool_result',
      name: 'edit_message',
      result: 'edited',
    })
  }
})

socketServer.on('permission_request', (path: string, msg: any) => {
  process.stderr.write(`hub: permission_request from ${path}: ${msg.toolName} (${msg.requestId})\n`)
  const response = permissions.handle(path, {
    requestId: msg.requestId,
    toolName: msg.toolName,
    description: msg.description,
    inputPreview: msg.inputPreview,
    toolArgs: msg.toolArgs,  // NEW
  })
  if (response) {
    socketServer.sendToSession(path, {
      type: 'permission_response',
      requestId: response.requestId,
      behavior: response.behavior,
    })
  }
})

// Start everything
async function start(): Promise<void> {
  await socketServer.start()
  process.stderr.write(`hub: socket server listening on ${SOCKET_PATH}\n`)

  let telegramBotUsername = config.telegramBotUsername ?? ''
  if (!telegramBotUsername && config.telegramToken) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getMe`)
      const data = await res.json() as any
      if (data.ok) telegramBotUsername = data.result.username
    } catch {}
  }
  if (telegramBotUsername) {
    process.stderr.write(`hub: telegram login widget bot = @${telegramBotUsername}\n`)
  }

  webFrontend = new WebFrontend({
    port: config.webPort,
    registry,
    router,
    permissions,
    socketServer,
    screenManager,
    telegramToken: config.telegramToken,
    telegramBotUsername,
    telegramAllowFrom: config.telegramAllowFrom,
    taskMonitor,
  })
  await webFrontend.start()
  process.stderr.write(`hub: web UI at http://localhost:${webFrontend.port}\n`)

  if (config.telegramToken) {
    telegramFrontend = new TelegramFrontend({
      token: config.telegramToken,
      registry,
      router,
      permissions,
      screenManager,
      socketServer,
      allowFrom: config.telegramAllowFrom,
      taskMonitor,
    })
    telegramFrontend.start().catch(err => {
      process.stderr.write(`hub: telegram failed to start: ${err}\n`)
    })
  } else {
    process.stderr.write('hub: no telegram token — skipping telegram frontend\n')
  }

  // Permission relay works natively through the MCP channel protocol.
  // No tmux polling needed — Claude Code sends permission_request notifications
  // directly to the shim, which forwards them to the daemon.

  process.stderr.write('hub: daemon ready\n')
}

async function shutdown(): Promise<void> {
  process.stderr.write('hub: shutting down...\n')
  taskMonitor.stopPolling()
  saveSessions(registry.toSaveFormat())
  await screenManager.killAll()
  await socketServer.stop()
  await webFrontend?.stop()
  await telegramFrontend?.stop()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
// Ignore stdin close — daemon should not die when terminal detaches
process.stdin.on('end', () => {})
process.stdin.on('close', () => {})
process.stdin.resume()

// Prevent unhandled rejections from crashing the daemon
process.on('unhandledRejection', err => {
  process.stderr.write(`hub: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`hub: uncaught exception: ${err}\n`)
})

start().catch(err => {
  process.stderr.write(`hub: failed to start: ${err}\n`)
  process.exit(1)
})
