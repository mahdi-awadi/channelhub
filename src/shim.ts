// src/shim.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { connect } from 'net'
import { join } from 'path'
import { homedir } from 'os'
import type { DaemonToShim, ShimToDaemon } from './types'

const SOCKET_PATH = process.env.HUB_SOCKET ?? join(homedir(), '.claude', 'channels', 'hub', 'hub.sock')

// Exported helpers for testing
export function parseShimMessage(line: string): DaemonToShim {
  return JSON.parse(line) as DaemonToShim
}

export function buildMcpToolResult(text: string, isError?: boolean) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  }
}

export function buildMcpNotification(content: string, meta: Record<string, string>) {
  return {
    method: 'notifications/claude/channel' as const,
    params: { content, meta },
  }
}

// Only run main when executed directly (not imported for tests)
if (import.meta.main) {
  main()
}

function isAgentTeammate(): boolean {
  // Check if parent process is a Claude agent teammate (has --agent-id in cmdline)
  try {
    const ppid = process.ppid
    const cmdline = require('fs').readFileSync(`/proc/${ppid}/cmdline`, 'utf8')
    return cmdline.includes('--agent-id')
  } catch {
    return false
  }
}

function getHubTmuxSession(): string | null {
  // Only register with the hub if we're running inside a tmux pane whose
  // session name begins with "hub-". Anything else (GNU screen, bare terminal,
  // a separate tmux server, nested sessions) is ignored.
  const pane = process.env.TMUX_PANE
  if (!pane) return null
  try {
    const { execSync } = require('child_process')
    const sessionName = execSync(`tmux display-message -p -t ${pane} '#S'`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    return sessionName.startsWith('hub-') ? sessionName : null
  } catch {
    return null
  }
}

function startStubMcpServer(): void {
  // Keeps Claude happy (the MCP server it configured exists) but does not
  // connect to the daemon — so this Claude instance is invisible to the hub.
  const mcp = new Server(
    { name: 'channelhub', version: '0.1.0' },
    { capabilities: { tools: {}, experimental: { 'claude/channel': {} } } },
  )
  mcp.connect(new StdioServerTransport()).catch(() => {})
}

function main() {
  // Skip registration for agent teammates spawned by Claude's agent teams feature.
  if (isAgentTeammate()) {
    process.stderr.write('hub shim: agent teammate detected, skipping hub registration\n')
    startStubMcpServer()
    return
  }

  // Skip registration unless we're inside a hub-managed tmux session.
  // This prevents stray Claude instances (from other terminals, screen, etc.)
  // from joining the hub and appearing as phantom teammates.
  const hubSession = getHubTmuxSession()
  if (!hubSession) {
    process.stderr.write('hub shim: not inside a hub-* tmux session, skipping registration\n')
    startStubMcpServer()
    return
  }
  process.stderr.write(`hub shim: running inside tmux session "${hubSession}"\n`)

  const cwd = process.cwd()
  const daemon = connect(SOCKET_PATH)
  let registered = false

  const mcp = new Server(
    { name: 'channelhub', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
      },
      instructions: [
        'This session is connected to Claude Code Hub — a multi-project management system.',
        'Messages arrive from the hub frontends (Telegram, Web, CLI).',
        'Reply with the reply tool — pass the text you want to send back.',
        'The hub routes your replies to the user on whichever frontend they are using.',
      ].join('\n'),
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description: 'Reply to the user via the hub. Text is routed to all connected frontends.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Absolute file paths to attach.',
            },
          },
          required: ['text'],
        },
      },
      {
        name: 'edit_message',
        description: 'Edit a previously sent message. Edits do not trigger push notifications.',
        inputSchema: {
          type: 'object',
          properties: {
            message_id: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['message_id', 'text'],
        },
      },
    ],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name
    const args = (req.params.arguments ?? {}) as Record<string, unknown>

    return new Promise((resolve) => {
      const handler = (chunk: Buffer) => {
        const lines = chunk.toString().trim().split('\n')
        for (const line of lines) {
          const msg = parseShimMessage(line)
          if (msg.type === 'tool_result' && msg.name === name) {
            daemon.off('data', handler)
            resolve(msg.isError
              ? buildMcpToolResult(String(msg.result), true)
              : buildMcpToolResult(String(msg.result))
            )
            return
          }
        }
      }
      daemon.on('data', handler)
      sendToDaemon({ type: 'tool_call', name, arguments: args })
    })
  })

  mcp.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel/permission_request'),
      params: z.object({
        request_id: z.string(),
        tool_name: z.string(),
        description: z.string(),
        input_preview: z.string(),
      }),
    }),
    async ({ params }) => {
      process.stderr.write(`hub shim: received permission_request: ${params.tool_name} (${params.request_id})\n`)
      // Try to parse input_preview as JSON for structured args
      let toolArgs: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(params.input_preview)
        if (parsed && typeof parsed === 'object') {
          toolArgs = parsed
        }
      } catch {
        // input_preview may be truncated or non-JSON; provide a fallback
        toolArgs = { command: params.input_preview }
      }

      sendToDaemon({
        type: 'permission_request',
        requestId: params.request_id,
        toolName: params.tool_name,
        description: params.description,
        inputPreview: params.input_preview,
        toolArgs,
      })
    },
  )

  let daemonBuffer = ''
  daemon.on('data', (chunk) => {
    daemonBuffer += chunk.toString()
    let idx: number
    while ((idx = daemonBuffer.indexOf('\n')) !== -1) {
      const line = daemonBuffer.slice(0, idx)
      daemonBuffer = daemonBuffer.slice(idx + 1)
      if (line.trim()) handleDaemonMessage(parseShimMessage(line))
    }
  })

  function handleDaemonMessage(msg: DaemonToShim): void {
    switch (msg.type) {
      case 'registered':
        registered = true
        process.stderr.write(`hub shim: registered as "${msg.sessionName}"\n`)
        break
      case 'rejected':
        process.stderr.write(`hub shim: rejected — ${msg.reason}\n`)
        process.exit(1)
        break
      case 'channel_message': {
        // Append a directive so Claude reliably calls the reply tool instead of
        // treating the message like an inline user prompt. The instructions field
        // on the MCP server is only seen once at init; this nudge is per-message.
        const annotated = `${msg.content}\n\n[hub] You must respond using the channelhub reply tool — do NOT just type your answer. Plain text in this terminal is not visible to the user; only the reply tool routes back to the frontend.`
        mcp.notification({
          method: 'notifications/claude/channel',
          params: { content: annotated, meta: msg.meta },
        }).catch((err) => {
          process.stderr.write(`hub shim: failed to deliver message: ${err}\n`)
        })
        break
      }
      case 'permission_response':
        mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: msg.requestId, behavior: msg.behavior },
        }).catch((err) => {
          process.stderr.write(`hub shim: failed to relay permission: ${err}\n`)
        })
        break
    }
  }

  function sendToDaemon(msg: ShimToDaemon): void {
    daemon.write(JSON.stringify(msg) + '\n')
  }

  daemon.on('connect', () => {
    sendToDaemon({ type: 'register', cwd })
  })

  daemon.on('error', (err) => {
    process.stderr.write(`hub shim: daemon connection error: ${err.message}\n`)
    process.stderr.write(`hub shim: is the daemon running? Start with: bun run daemon\n`)
    process.exit(1)
  })

  daemon.on('close', () => {
    process.stderr.write('hub shim: daemon disconnected\n')
    process.exit(0)
  })

  mcp.connect(new StdioServerTransport()).catch((err) => {
    process.stderr.write(`hub shim: MCP connect failed: ${err}\n`)
    process.exit(1)
  })

  process.stdin.on('end', () => {
    daemon.end()
    process.exit(0)
  })
  process.on('SIGTERM', () => { daemon.end(); process.exit(0) })
  process.on('SIGINT', () => { daemon.end(); process.exit(0) })
}
