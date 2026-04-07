// src/frontends/telegram.ts
import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy'
import type { SessionState, PermissionRequest } from '../types'
import type { SessionRegistry } from '../session-registry'
import type { MessageRouter } from '../message-router'
import type { PermissionEngine } from '../permission-engine'
import type { ScreenManager } from '../screen-manager'
import type { SocketServer } from '../socket-server'
import type { TaskMonitor } from '../task-monitor'

// ── Pure helper functions ────────────────────────────────────────────────────

export function formatSessionList(sessions: SessionState[], activeSession: string | null): string {
  if (sessions.length === 0) {
    return 'No sessions connected.'
  }

  const lines = sessions.map((s) => {
    const icon =
      s.status === 'active'
        ? '🟢'
        : s.status === 'respawning'
          ? '🟡'
          : '🔴'
    const trustLabel = s.trust === 'auto-approve' ? ' [auto]' : ''
    const activeMarker = s.name === activeSession ? ' ← active' : ''
    return `${icon} ${s.name}${trustLabel}${activeMarker}`
  })

  return lines.join('\n')
}

export function formatStatus(sessions: SessionState[]): string {
  if (sessions.length === 0) {
    return 'No sessions connected.'
  }

  const lines = sessions.map((s) => {
    const icon =
      s.status === 'active'
        ? '🟢'
        : s.status === 'respawning'
          ? '🟡'
          : '🔴'
    const parts = [`${icon} <b>${s.name}</b> (${s.status})`]
    parts.push(`  path: ${s.path}`)
    parts.push(`  trust: ${s.trust}`)
    if (s.prefix) parts.push(`  prefix: ${s.prefix}`)
    return parts.join('\n')
  })

  return lines.join('\n\n')
}

export function parseCommand(text: string): { command: string; args: string[] } | null {
  if (!text.startsWith('/')) return null
  const parts = text.slice(1).split(/\s+/)
  const command = parts[0]
  const args = parts.slice(1).filter((a) => a.length > 0)
  return { command, args }
}

export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > limit) {
    // Try to find a newline boundary within the limit
    const slice = remaining.slice(0, limit)
    const lastNewline = slice.lastIndexOf('\n')
    const cutAt = lastNewline > 0 ? lastNewline + 1 : limit
    chunks.push(remaining.slice(0, cutAt))
    remaining = remaining.slice(cutAt)
  }

  if (remaining.length > 0) {
    chunks.push(remaining)
  }

  return chunks
}

// ── TelegramFrontend class ───────────────────────────────────────────────────

type TelegramFrontendDeps = {
  token: string
  registry: SessionRegistry
  router: MessageRouter
  permissions: PermissionEngine
  screenManager: ScreenManager
  socketServer: SocketServer
  allowFrom: string[]
  taskMonitor: TaskMonitor | null
}

export class TelegramFrontend {
  private bot: Bot
  private registry: SessionRegistry
  private router: MessageRouter
  private permissions: PermissionEngine
  private screenManager: ScreenManager
  private socketServer: SocketServer
  private allowFrom: string[]
  private taskMonitor: TaskMonitor | null

  // Per-user active session: telegram user id → session name
  private userActiveSessions = new Map<string, string>()
  // Track all users who have messaged the bot (for delivering replies when allowFrom is empty)
  private knownUsers = new Set<string>()

  constructor(deps: TelegramFrontendDeps) {
    this.bot = new Bot(deps.token)
    this.bot.catch(err => {
      process.stderr.write(`hub telegram: handler error: ${err.error}\n`)
    })
    this.registry = deps.registry
    this.router = deps.router
    this.permissions = deps.permissions
    this.screenManager = deps.screenManager
    this.socketServer = deps.socketServer
    this.allowFrom = deps.allowFrom
    this.taskMonitor = deps.taskMonitor

    this.registerHandlers()
  }

  private isAllowed(ctx: { from?: { id: number } }): boolean {
    if (this.allowFrom.length === 0) return true
    if (!ctx.from) return false
    return this.allowFrom.includes(String(ctx.from.id))
  }

  private getUserId(ctx: { from?: { id: number } }): string {
    return String(ctx.from?.id ?? 'unknown')
  }

  private getActiveSession(userId: string): string | null {
    return this.userActiveSessions.get(userId) ?? null
  }

  private registerHandlers(): void {
    const bot = this.bot

    // /list — show sessions with inline buttons to select active
    bot.command('list', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const sessions = this.registry.list()
      const userId = this.getUserId(ctx)
      const activeSession = this.getActiveSession(userId)
      const text = formatSessionList(sessions, activeSession)

      if (sessions.length === 0) {
        await ctx.reply(text)
        return
      }

      const keyboard = new InlineKeyboard()
      for (const s of sessions) {
        keyboard.text(s.name, `select:${s.name}`).row()
      }
      await ctx.reply(text, { reply_markup: keyboard })
    })

    // /status — dashboard view
    bot.command('status', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const sessions = this.registry.list()
      await ctx.reply(formatStatus(sessions), { parse_mode: 'HTML' })
    })

    // /spawn <name> <path> [teamSize]
    bot.command('spawn', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const args = ctx.match?.trim().split(/\s+/) ?? []
      if (args.length < 2 || !args[0] || !args[1]) {
        await ctx.reply('Usage: /spawn <name> <path>')
        return
      }
      const [name, projectPath, sizeStr] = args
      const teamSize = sizeStr ? parseInt(sizeStr) : 1
      try {
        if (teamSize > 1) {
          await this.screenManager.spawnTeam(name, projectPath, teamSize)
          await ctx.reply(`Spawned team ${name} (${teamSize} agents) at ${projectPath}`)
        } else {
          await this.screenManager.spawn(name, projectPath)
          await ctx.reply(`Spawned session ${name} at ${projectPath}`)
        }
      } catch (err) {
        await ctx.reply(`Failed to spawn: ${err}`)
      }
    })

    // /team <name> [add]
    bot.command('team', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const args = ctx.match?.trim().split(/\s+/) ?? []
      if (args.length === 0 || !args[0]) {
        await ctx.reply('Usage: /team <name> [add]')
        return
      }
      const teamName = args[0]
      const action = args[1]

      if (action === 'add') {
        const newName = await this.screenManager.addTeammate(teamName)
        if (newName) {
          await ctx.reply(`Added teammate: ${newName}`)
        } else {
          await ctx.reply(`Team lead "${teamName}" not found`)
        }
        return
      }

      // Show team status
      const path = this.registry.findByName(teamName)
      if (!path) {
        await ctx.reply(`Session "${teamName}" not found`)
        return
      }
      const folder = path.replace(/:\d+$/, '')
      const team = this.registry.getTeam(folder)
      if (team.length <= 1) {
        await ctx.reply(`${teamName} is a solo session, not a team`)
        return
      }

      const lines = team.map((s, i) => {
        const icon = s.status === 'active' ? '🟢' : '🔴'
        const role = i === 0 ? '👑 ' : '  ├ '
        return `${role}${s.name} ${icon}`
      })

      await ctx.reply(lines.join('\n'))
    })

    // /kill <name>
    bot.command('kill', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const name = ctx.match?.trim()
      if (!name) {
        await ctx.reply('Usage: /kill <name>')
        return
      }
      const path = this.registry.findByName(name)
      if (!path) {
        await ctx.reply(`Session not found: ${name}`)
        return
      }
      await this.screenManager.gracefulKill(name)
      this.registry.unregister(path)
      await ctx.reply(`Killed session ${name}`)
    })

    // /rename <old> <new>
    bot.command('rename', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const args = ctx.match?.trim().split(/\s+/) ?? []
      if (args.length < 2 || !args[0] || !args[1]) {
        await ctx.reply('Usage: /rename <old> <new>')
        return
      }
      const [oldName, newName] = args
      const path = this.registry.findByName(oldName)
      if (!path) {
        await ctx.reply(`Session not found: ${oldName}`)
        return
      }
      this.registry.rename(path, newName)
      await ctx.reply(`Renamed ${oldName} → ${newName}`)
    })

    // /trust <name> [auto|ask]
    bot.command('trust', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const args = ctx.match?.trim().split(/\s+/) ?? []
      if (!args[0]) {
        await ctx.reply('Usage: /trust <name> [auto|ask]')
        return
      }
      const name = args[0]
      const path = this.registry.findByName(name)
      if (!path) {
        await ctx.reply(`Session not found: ${name}`)
        return
      }
      const session = this.registry.get(path)!
      let newTrust: 'auto-approve' | 'ask'
      if (args[1] === 'auto') {
        newTrust = 'auto-approve'
      } else if (args[1] === 'ask') {
        newTrust = 'ask'
      } else {
        // Toggle
        newTrust = session.trust === 'auto-approve' ? 'ask' : 'auto-approve'
      }
      this.registry.setTrust(path, newTrust)
      await ctx.reply(`Trust for ${name} set to ${newTrust}`)
    })

    // /prefix <name> <text>
    bot.command('prefix', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const match = ctx.match?.trim() ?? ''
      const spaceIdx = match.indexOf(' ')
      if (spaceIdx === -1) {
        await ctx.reply('Usage: /prefix <name> <text>')
        return
      }
      const name = match.slice(0, spaceIdx)
      const prefixText = match.slice(spaceIdx + 1)
      const path = this.registry.findByName(name)
      if (!path) {
        await ctx.reply(`Session not found: ${name}`)
        return
      }
      this.registry.setPrefix(path, prefixText)
      await ctx.reply(`Prefix for ${name} set to: ${prefixText}`)
    })

    // /all <message>
    bot.command('all', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const message = ctx.match?.trim()
      if (!message) {
        await ctx.reply('Usage: /all <message>')
        return
      }
      const userId = this.getUserId(ctx)
      this.router.broadcast(message, 'telegram', userId)
      await ctx.reply('Broadcast sent to all active sessions.')
    })

    // Callback query handler
    bot.on('callback_query:data', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const data = ctx.callbackQuery.data
      const userId = this.getUserId(ctx)

      if (data.startsWith('select:')) {
        const sessionName = data.slice('select:'.length)
        this.userActiveSessions.set(userId, sessionName)
        await ctx.answerCallbackQuery(`Active session set to: ${sessionName}`)
        await ctx.editMessageText(
          formatSessionList(this.registry.list(), sessionName),
        )
      } else if (data.startsWith('perm:allow:')) {
        const requestId = data.slice('perm:allow:'.length)
        const result = this.permissions.resolve(requestId, 'allow')
        if (result) {
          this.socketServer.sendToSession(result.sessionPath, {
            type: 'permission_response',
            requestId: result.response.requestId,
            behavior: result.response.behavior,
          })
          await ctx.answerCallbackQuery('Permission allowed')
          await ctx.editMessageText(`✅ Allowed: ${requestId}`)
        } else {
          await ctx.answerCallbackQuery('Permission request not found')
        }
      } else if (data.startsWith('perm:deny:')) {
        const requestId = data.slice('perm:deny:'.length)
        const result = this.permissions.resolve(requestId, 'deny')
        if (result) {
          this.socketServer.sendToSession(result.sessionPath, {
            type: 'permission_response',
            requestId: result.response.requestId,
            behavior: result.response.behavior,
          })
          await ctx.answerCallbackQuery('Permission denied')
          await ctx.editMessageText(`❌ Denied: ${requestId}`)
        } else {
          await ctx.answerCallbackQuery('Permission request not found')
        }
      }
    })

    // Message: photo
    bot.on('message:photo', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const userId = this.getUserId(ctx)
      this.knownUsers.add(userId)

      const activeName = this.userActiveSessions.get(userId)
      if (!activeName) {
        await ctx.reply('No active session. Use /list to select one.')
        return
      }

      const path = this.registry.findByName(activeName)
      if (!path) { await ctx.reply('Session not found.'); return }
      const session = this.registry.get(path)
      if (!session) return

      const caption = ctx.message.caption ?? ''
      const photos = ctx.message.photo
      const best = photos[photos.length - 1] // largest size

      try {
        const file = await ctx.api.getFile(best.file_id)
        if (!file.file_path) throw new Error('No file path')

        const token = this.bot.token
        const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
        const res = await fetch(url)
        const buf = Buffer.from(await res.arrayBuffer())

        const ext = file.file_path.split('.').pop() ?? 'jpg'
        const fileName = `photo-${Date.now()}.${ext}`
        const { mkdirSync, writeFileSync } = await import('fs')
        const { join: pathJoin } = await import('path')
        const uploadDir = pathJoin(session.path.replace(/:\d+$/, ''), session.uploadDir)
        mkdirSync(uploadDir, { recursive: true })
        const destPath = pathJoin(uploadDir, fileName)
        writeFileSync(destPath, buf)

        // Notify Claude via channel
        this.socketServer.sendToSession(path, {
          type: 'channel_message',
          content: caption ? `${caption}\n\n[Photo uploaded: ${destPath}]` : `[Photo uploaded: ${destPath}]`,
          meta: { source: 'hub', frontend: 'telegram', user: ctx.from!.username ?? String(ctx.from!.id), session: activeName, image_path: destPath },
        })

        await ctx.reply(`📷 Uploaded to ${activeName}:${session.uploadDir}/${fileName}`)
      } catch (err) {
        await ctx.reply(`Failed to upload photo: ${err}`)
      }
    })

    // Message: document (file upload)
    bot.on('message:document', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const userId = this.getUserId(ctx)
      this.knownUsers.add(userId)

      const activeName = this.userActiveSessions.get(userId)
      if (!activeName) {
        await ctx.reply('No active session. Use /list to select one.')
        return
      }

      const path = this.registry.findByName(activeName)
      if (!path) { await ctx.reply('Session not found.'); return }
      const session = this.registry.get(path)
      if (!session) return

      const doc = ctx.message.document
      const caption = ctx.message.caption ?? ''

      try {
        const file = await ctx.api.getFile(doc.file_id)
        if (!file.file_path) throw new Error('No file path')

        const token = this.bot.token
        const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
        const res = await fetch(url)
        const buf = Buffer.from(await res.arrayBuffer())

        const fileName = doc.file_name ?? `file-${Date.now()}`
        const { mkdirSync, writeFileSync } = await import('fs')
        const { join: pathJoin } = await import('path')
        const uploadDir = pathJoin(session.path.replace(/:\d+$/, ''), session.uploadDir)
        mkdirSync(uploadDir, { recursive: true })
        const destPath = pathJoin(uploadDir, fileName)
        writeFileSync(destPath, buf)

        // Notify Claude via channel
        this.socketServer.sendToSession(path, {
          type: 'channel_message',
          content: caption ? `${caption}\n\n[File uploaded: ${destPath}]` : `[File uploaded: ${destPath}]`,
          meta: { source: 'hub', frontend: 'telegram', user: ctx.from!.username ?? String(ctx.from!.id), session: activeName },
        })

        await ctx.reply(`📄 Uploaded ${fileName} to ${activeName}:${session.uploadDir}/`)
      } catch (err) {
        await ctx.reply(`Failed to upload file: ${err}`)
      }
    })

    // Message: text
    bot.on('message:text', async (ctx) => {
      if (!this.isAllowed(ctx)) return
      const text = ctx.message.text
      const userId = this.getUserId(ctx)
      this.knownUsers.add(userId)

      // Check for targeted message via router
      const targeted = this.router.parseTargetedMessage(text)
      if (targeted) {
        const sent = this.router.routeToSession(targeted.sessionName, targeted.text, 'telegram', userId)
        if (!sent) {
          await ctx.reply(`Session "${targeted.sessionName}" is not active.`)
        }
        return
      }

      // Send to active session
      const activeSession = this.getActiveSession(userId)
      if (!activeSession) {
        await ctx.reply('No active session selected. Use /list to select one.')
        return
      }
      const sent = this.router.routeToSession(activeSession, text, 'telegram', userId)
      if (!sent) {
        await ctx.reply(`Session "${activeSession}" is not active.`)
      }
    })
  }

  async deliverToUser(sessionName: string, text: string, files?: string[]): Promise<void> {
    const recipients = this.allowFrom.length > 0 ? this.allowFrom : [...this.knownUsers]
    if (recipients.length === 0) return

    const fullText = `[${sessionName}] ${text}`
    const chunks = chunkText(fullText, 4096)

    for (const userId of recipients) {
      for (const chunk of chunks) {
        await this.bot.api.sendMessage(userId, chunk)
      }
      if (files && files.length > 0) {
        for (const filePath of files) {
          await this.bot.api.sendDocument(userId, new InputFile(filePath))
        }
      }
    }
  }

  async deliverPermissionRequest(req: PermissionRequest): Promise<void> {
    const recipients = this.allowFrom.length > 0 ? this.allowFrom : [...this.knownUsers]
    if (recipients.length === 0) return

    const text =
      `🔐 Permission request from <b>${req.sessionName}</b>\n` +
      `Tool: <code>${req.toolName}</code>\n` +
      `Description: ${req.description}\n` +
      `Preview: <code>${req.inputPreview}</code>`

    const keyboard = new InlineKeyboard()
      .text('✅ Allow', `perm:allow:${req.requestId}`)
      .text('❌ Deny', `perm:deny:${req.requestId}`)

    for (const userId of recipients) {
      await this.bot.api.sendMessage(userId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      })
    }
  }

  async start(): Promise<void> {
    // Retry with backoff on 409 Conflict (another bot instance polling)
    for (let attempt = 1; ; attempt++) {
      try {
        await this.bot.start({
          onStart: (info) => {
            process.stderr.write(`hub telegram: polling as @${info.username}\n`)
          },
        })
        return
      } catch (err) {
        if (err instanceof GrammyError && err.error_code === 409) {
          const delay = Math.min(1000 * attempt, 15000)
          const detail = attempt === 1 ? ' — another instance may still be shutting down' : ''
          process.stderr.write(`hub telegram: 409 Conflict${detail}, retrying in ${delay / 1000}s\n`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        throw err
      }
    }
  }

  async stop(): Promise<void> {
    await this.bot.stop()
  }
}
