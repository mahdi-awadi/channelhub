// src/frontends/web.ts
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { writeFile } from 'fs/promises'
import { createHmac, createHash } from 'crypto'
import type { SessionRegistry } from '../session-registry'
import type { MessageRouter } from '../message-router'
import type { PermissionEngine } from '../permission-engine'
import type { SocketServer } from '../socket-server'
import type { ScreenManager } from '../screen-manager'
import type { PermissionRequest, TrustLevel } from '../types'
import type { TaskMonitor } from '../task-monitor'

type WebFrontendDeps = {
  port: number
  registry: SessionRegistry
  router: MessageRouter | null
  permissions: PermissionEngine | null
  socketServer: SocketServer | null
  screenManager: ScreenManager | null
  telegramToken: string
  telegramBotUsername: string
  telegramAllowFrom: string[]
  taskMonitor: TaskMonitor | null
}

export class WebFrontend {
  private deps: WebFrontendDeps
  private clients = new Set<import('bun').ServerWebSocket<unknown>>()
  private server: import('bun').Server<unknown> | null = null
  private _port: number

  constructor(deps: WebFrontendDeps) {
    this.deps = deps
    this._port = deps.port
  }

  get port(): number {
    return this._port
  }

  async start(): Promise<void> {
    const htmlPath = join(dirname(fileURLToPath(import.meta.url)), 'web-client.html')
    const html = readFileSync(htmlPath, 'utf8')
      .replace('__TELEGRAM_BOT_USERNAME__', this.deps.telegramBotUsername ?? '')

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this

    this.server = Bun.serve({
      port: this.deps.port,
      fetch(req, server) {
        const url = new URL(req.url)

        // WebSocket upgrade
        if (url.pathname === '/ws') {
          const upgraded = server.upgrade(req, { data: {} })
          if (upgraded) return undefined as unknown as Response
          return new Response('WebSocket upgrade failed', { status: 400 })
        }

        // Favicon — empty SVG to prevent 404
        if (url.pathname === '/favicon.ico') {
          return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text y="28" font-size="28">⚡</text></svg>', {
            headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' },
          })
        }

        // Serve HTML
        if (url.pathname === '/' || url.pathname === '/index.html') {
          return new Response(html, {
            headers: { 'Content-Type': 'text/html' },
          })
        }

        // Telegram login verification
        if (url.pathname === '/api/auth/telegram' && req.method === 'POST') {
          return self.handleTelegramAuth(req)
        }

        // Browse directories
        if (url.pathname === '/api/browse' && req.method === 'GET') {
          const dirPath = url.searchParams.get('path') || '/home/'
          try {
            const entries = readdirSync(dirPath)
            const dirs = entries
              .filter(e => {
                try { return statSync(join(dirPath, e)).isDirectory() && !e.startsWith('.') } catch { return false }
              })
              .sort()
              .map(e => join(dirPath, e) + '/')
            return Response.json(dirs)
          } catch {
            return Response.json([])
          }
        }

        // API routes
        if (url.pathname === '/api/sessions' && req.method === 'GET') {
          const sessions = self.deps.registry.list()
          return Response.json(sessions)
        }

        if (url.pathname === '/api/upload-temp' && req.method === 'POST') {
          return self.handleUploadTemp(req)
        }

        if (url.pathname === '/api/upload' && req.method === 'POST') {
          return self.handleUpload(req)
        }

        if (url.pathname === '/api/spawn' && req.method === 'POST') {
          return self.handleSpawn(req)
        }

        if (url.pathname === '/api/kill' && req.method === 'POST') {
          return self.handleKill(req)
        }

        if (url.pathname === '/api/send' && req.method === 'POST') {
          return self.handleSend(req)
        }

        if (url.pathname === '/api/trust' && req.method === 'POST') {
          return self.handleTrust(req)
        }

        if (url.pathname === '/api/prefix' && req.method === 'POST') {
          return self.handlePrefix(req)
        }

        if (url.pathname === '/api/rename' && req.method === 'POST') {
          return self.handleRename(req)
        }

        if (url.pathname === '/api/team/add' && req.method === 'POST') {
          return req.json().then(async (body: any) => {
            const newName = await self.deps.screenManager?.addTeammate(body.leadName)
            if (newName) {
              return Response.json({ ok: true, name: newName })
            }
            return new Response('Lead not found', { status: 404 })
          })
        }

        if (url.pathname === '/api/activity' && req.method === 'GET') {
          const activity = self.deps.permissions?.getActivity() ?? []
          return Response.json(activity)
        }

        return new Response('Not Found', { status: 404 })
      },
      websocket: {
        open(ws) {
          self.clients.add(ws)
          const sessions = self.deps.registry.list()
          ws.send(JSON.stringify({ type: 'sessions', data: sessions }))
        },
        message(ws, data) {
          try {
            const msg = JSON.parse(typeof data === 'string' ? data : data.toString())
            self.handleWsMessage(ws, msg)
          } catch (e) {
            console.error('WS message parse error', e)
          }
        },
        close(ws) {
          self.clients.delete(ws)
        },
      },
    })

    this._port = this.server.port ?? this.deps.port
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop(true)
      this.server = null
    }
  }

  broadcastToClients(msg: unknown): void {
    const text = JSON.stringify(msg)
    for (const ws of this.clients) {
      ws.send(text)
    }
  }

  deliverToUser(sessionName: string, text: string, files?: string[]): void {
    this.broadcastToClients({ type: 'message', sessionName, text, files })
  }

  deliverPermissionRequest(req: PermissionRequest): void {
    this.broadcastToClients({ type: 'permission', ...req })
  }

  refreshSessions(): void {
    const sessions = this.deps.registry.list()
    this.broadcastToClients({ type: 'sessions', data: sessions })
  }

  deliverTaskUpdate(tasks: Record<string, any[]>): void {
    this.broadcastToClients({ type: 'tasks', data: tasks })
  }

  private handleWsMessage(ws: import('bun').ServerWebSocket<unknown>, msg: Record<string, unknown>): void {
    if (msg.type === 'message') {
      const { text, sessionName } = msg as { text: string; sessionName: string }
      if (this.deps.router && text && sessionName) {
        this.deps.router.routeToSession(sessionName, text, 'web', 'web-user')
      }
    } else if (msg.type === 'spawn') {
      const { name, path, teamSize, instructions } = msg as { name: string; path: string; teamSize?: number; instructions?: string }
      if (this.deps.screenManager && name && path) {
        const size = teamSize ?? 1
        if (size > 1) {
          this.deps.screenManager.spawnTeam(name, path, size, instructions).catch(console.error)
        } else {
          this.deps.screenManager.spawn(name, path, instructions).catch(console.error)
        }
      }
    } else if (msg.type === 'permission_response') {
      const { requestId, behavior, option } = msg as { requestId: string; behavior: 'allow' | 'deny'; option?: number }
      if (requestId && behavior) {
        if (this.deps.permissions) {
          const result = this.deps.permissions.resolve(requestId, behavior)
          if (result && this.deps.socketServer) {
            this.deps.socketServer.sendToSession(result.sessionPath, {
              type: 'permission_response',
              requestId: result.response.requestId,
              behavior: result.response.behavior,
            })
          }
        }
      }
    }
  }

  private async handleUploadTemp(req: Request): Promise<Response> {
    try {
      const form = await req.formData()
      const file = form.get('file') as File | null
      if (!file) return new Response('Missing file', { status: 400 })

      const { mkdirSync, writeFileSync } = await import('fs')
      const tmpDir = join('/tmp', 'hub-uploads')
      mkdirSync(tmpDir, { recursive: true })
      const fileName = `${Date.now()}-${file.name}`
      const destPath = join(tmpDir, fileName)
      writeFileSync(destPath, Buffer.from(await file.arrayBuffer()))

      return Response.json({ path: destPath, name: file.name })
    } catch (err) {
      return new Response('Upload failed', { status: 500 })
    }
  }

  private async handleTelegramAuth(req: Request): Promise<Response> {
    try {
      const data = await req.json() as Record<string, any>
      const { hash, ...userData } = data

      if (!hash || !this.deps.telegramToken) {
        return new Response('Missing auth data', { status: 400 })
      }

      // Verify Telegram hash: https://core.telegram.org/widgets/login#checking-authorization
      const secretKey = createHash('sha256').update(this.deps.telegramToken).digest()
      const checkString = Object.keys(userData)
        .sort()
        .map(k => `${k}=${userData[k]}`)
        .join('\n')
      const hmac = createHmac('sha256', secretKey).update(checkString).digest('hex')

      if (hmac !== hash) {
        return new Response('Invalid auth hash', { status: 403 })
      }

      // Check auth_date is not too old (allow 1 day)
      const authDate = Number(userData.auth_date)
      if (Date.now() / 1000 - authDate > 86400) {
        return new Response('Auth expired', { status: 403 })
      }

      // Check if user is in allowFrom list
      const userId = String(userData.id)
      if (this.deps.telegramAllowFrom.length > 0 && !this.deps.telegramAllowFrom.includes(userId)) {
        return new Response('User not authorized', { status: 403 })
      }

      return Response.json({ ok: true, user: userData })
    } catch (err) {
      return new Response('Auth failed', { status: 500 })
    }
  }

  private async handleUpload(req: Request): Promise<Response> {
    try {
      const formData = await req.formData()
      const file = formData.get('file') as File | null
      const sessionName = formData.get('sessionName') as string | null

      if (!file || !sessionName) {
        return new Response('Missing file or sessionName', { status: 400 })
      }

      const path = this.deps.registry.findByName(sessionName)
      if (!path) {
        return new Response(`Session not found: ${sessionName}`, { status: 404 })
      }

      const session = this.deps.registry.get(path)!
      const savePath = join(session.uploadDir, file.name)
      const buffer = await file.arrayBuffer()
      await writeFile(savePath, new Uint8Array(buffer))

      if (this.deps.router) {
        this.deps.router.routeToSession(
          sessionName,
          `[File uploaded: ${savePath}]`,
          'web',
          'web-user',
        )
      }

      return Response.json({ path: savePath })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handleSpawn(req: Request): Promise<Response> {
    try {
      const { name, path, teamSize, instructions } = (await req.json()) as { name: string; path: string; teamSize?: number; instructions?: string }
      if (!this.deps.screenManager) return new Response('No screen manager', { status: 503 })
      const size = teamSize ?? 1
      if (size > 1) {
        // Don't await — spawnTeam takes 10+ seconds, respond immediately
        this.deps.screenManager.spawnTeam(name, path, size, instructions).catch(err => {
          process.stderr.write(`hub: spawnTeam error: ${err}\n`)
        })
      } else {
        await this.deps.screenManager.spawn(name, path, instructions)
      }
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handleKill(req: Request): Promise<Response> {
    try {
      const { name } = (await req.json()) as { name: string }
      if (!this.deps.screenManager) return new Response('No screen manager', { status: 503 })
      await this.deps.screenManager.kill(name)
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handleSend(req: Request): Promise<Response> {
    try {
      const { sessionName, text } = (await req.json()) as { sessionName: string; text: string }
      if (!this.deps.router) return new Response('No router', { status: 503 })
      this.deps.router.routeToSession(sessionName, text, 'web', 'web-user')
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handleTrust(req: Request): Promise<Response> {
    try {
      const { name, level } = (await req.json()) as { name: string; level: string }
      const path = this.deps.registry.findByName(name)
      if (!path) return new Response(`Session not found: ${name}`, { status: 404 })
      this.deps.registry.setTrust(path, level as TrustLevel)
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handlePrefix(req: Request): Promise<Response> {
    try {
      const { name, text } = (await req.json()) as { name: string; text: string }
      const path = this.deps.registry.findByName(name)
      if (!path) return new Response(`Session not found: ${name}`, { status: 404 })
      this.deps.registry.setPrefix(path, text)
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }

  private async handleRename(req: Request): Promise<Response> {
    try {
      const { oldName, newName } = (await req.json()) as { oldName: string; newName: string }
      const path = this.deps.registry.findByName(oldName)
      if (!path) return new Response(`Session not found: ${oldName}`, { status: 404 })
      this.deps.registry.rename(path, newName)
      return Response.json({ ok: true })
    } catch (err) {
      return new Response(String(err), { status: 500 })
    }
  }
}
