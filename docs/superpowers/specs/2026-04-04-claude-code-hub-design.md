# Claude Code Hub — Design Spec

## Overview

A single-process hub that acts as an MCP channel server for multiple Claude Code sessions, with three frontends: Web PWA, Telegram bot, and CLI. Uses your Claude Code subscription (no API costs). Runs on the same machine as your Claude Code sessions.

## Problem

Claude Code channels are one-session-per-channel. There's no way to manage multiple projects from one interface, see a dashboard of all running sessions, or control permissions centrally.

## Solution

A hub process that:
- Accepts MCP stdio connections from multiple Claude Code sessions
- Routes messages between sessions and frontends (Web, Telegram, CLI)
- Manages session lifecycles (spawn in screen, respawn on crash)
- Handles permission relay with per-project trust levels

## Architecture

The system has two layers: a long-running **daemon** and short-lived **shim** processes.

```
┌─────────────────────────────────────────────────────┐
│                   HUB DAEMON                         │
│              (long-running, started once)             │
│                                                      │
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │ Session       │  │ Frontend Manager             │ │
│  │ Registry      │  │                              │ │
│  │               │  │  ┌─────────┐ ┌────────────┐ │ │
│  │ project-a ●──┼──┼─▶│ Web PWA │ │ Telegram   │ │ │
│  │ project-b ●──┼──┼─▶│ (WS)    │ │ Bot        │ │ │
│  │ project-c ●──┼──┼─▶│         │ │            │ │ │
│  │               │  │  └─────────┘ └────────────┘ │ │
│  └──────────────┘  └──────────────────────────────┘ │
│                                                      │
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │ Permission    │  │ Screen Manager               │ │
│  │ Engine        │  │ (spawn/respawn sessions)     │ │
│  └──────────────┘  └──────────────────────────────┘ │
│                                                      │
│  Unix socket: ~/.claude/channels/hub/hub.sock        │
│    ▲            ▲            ▲                        │
└────┼────────────┼────────────┼────────────────────────┘
     │            │            │
┌────┴───┐  ┌────┴───┐  ┌────┴───┐
│ shim   │  │ shim   │  │ shim   │   (one per Claude session)
│ stdio↔ │  │ stdio↔ │  │ stdio↔ │
│ socket │  │ socket │  │ socket │
└────┬───┘  └────┬───┘  └────┬───┘
     │            │            │
  claude       claude       claude
  (proj-a)     (proj-b)     (proj-c)
```

**Why two layers:** Claude Code launches channel servers as child processes via stdio — one per session. A single process can't serve multiple stdio pairs. So:

- **Hub daemon** — started once (`hub start`). Runs Telegram bot, web server, screen manager, session registry. Listens on a Unix socket.
- **Shim** — tiny process launched by `claude --channels server:hub-shim`. Bridges stdio (MCP with Claude) ↔ Unix socket (to daemon). Sends its CWD on connect so the daemon knows which project it is.

The shim is ~50 lines. All logic lives in the daemon.

### Modules

1. **Session Registry** — tracks all connected sessions by folder path (unique key)
2. **Permission Engine** — per-project trust level: auto-approve or forward to user
3. **Frontend Manager** — WebSocket server for PWA + Telegram bot + CLI API
4. **Screen Manager** — spawns/monitors Claude Code in screen sessions, respawns on crash
5. **Socket Server** — accepts connections from shim processes, maps them to sessions

## Session Lifecycle

### Identity

- **Folder path is the unique key.** Two sessions from the same folder are forbidden — hub rejects the second.
- **Display name** = folder basename (e.g., `/home/user/frontend` → `frontend`). Renameable.
- CWD detected via `/proc/<pid>/cwd` of the stdio child process on connect.

### Auto-detect Mode

1. User runs `claude --channels server:hub-shim` in a project folder
2. Shim starts, connects to daemon via Unix socket, sends CWD
3. Daemon registers session, appears in `/list` on all frontends
4. When Claude exits, shim disconnects, daemon marks session as `disconnected`

### Engine-managed Mode

1. User runs `/spawn frontend /home/user/frontend` (Telegram/Web/CLI)
2. Daemon creates screen session: `screen -dmS hub-frontend`
3. Inside screen: `cd /home/user/frontend && claude --channels server:hub-shim`
4. Hub monitors the screen — if it dies, respawn after 3 seconds
5. `/kill frontend` stops the session and screen
6. User can `screen -r hub-frontend` to attach directly

## Telegram Frontend

### Commands

| Command | Description |
|---------|-------------|
| `/list` | Show all sessions with inline buttons, pick one as active |
| `/status` | Dashboard: all sessions, status, current activity |
| `/spawn <name> <path>` | Launch new Claude Code session in screen |
| `/kill <name>` | Stop a session |
| `/rename <old> <new>` | Rename display name |
| `/trust <name>` | Toggle auto-approve for a session |
| `/prefix <name> <text>` | Set command prefix for a session |
| `/all <message>` | Broadcast to all active sessions |

### Message Routing

- **Plain text** → goes to the **active session** (selected via `/list`)
- **`/<session-name> do something`** → goes to that specific session regardless of active
- **Incoming from all sessions** → delivered with prefix: `[frontend] Fixed the login bug...`
- No need to switch active session just to send one message to another project

### Permission Prompts

- **Trusted sessions (auto-approve):** Hub sends `allow` automatically, user never sees them
- **Untrusted sessions (ask):** User gets `[frontend] 🔐 Bash: npm install` with Allow/Deny inline buttons

### File Uploads

- Send a file via Telegram → hub saves it to the active project's folder
- Configurable upload subdirectory per project (default: project root)
- Claude gets notified: "File `design.png` uploaded to `/home/user/frontend/uploads/`"

## Web PWA Frontend

Served by hub on a local port (default: `http://localhost:3000`).

### Dashboard View

- List of all sessions: name, status (active/disconnected/respawning), trust level
- Quick actions: spawn, kill, rename, toggle trust, set prefix

### Chat View

- Left sidebar: session list (like a chat app)
- Main area: conversation with selected session
- Messages from other sessions appear as notification badges in sidebar
- Permission prompts shown as inline cards with Allow/Deny buttons
- Type `/<session-name> message` to target another session without switching

### File Upload

- Drag and drop or file picker → uploads to selected project's folder

## CLI Frontend

```bash
hub list                                  # show all sessions
hub spawn frontend /home/user/frontend    # launch session in screen
hub kill frontend                         # stop session
hub send frontend "fix the login bug"     # send message to a session
hub trust frontend auto                   # set trust level (auto/ask)
hub prefix frontend "You are a Next.js expert."  # set command prefix
hub status                                # dashboard view in terminal
hub upload frontend ./design.png          # copy file to project folder
hub rename frontend my-app                # rename display name
```

CLI communicates with the hub via HTTP/WebSocket on the local port.

## Command Prefix

Per-project configurable prefix prepended to every message before sending to Claude.

Example: project `frontend` has prefix `"You are working on a Next.js app."` → when user types "fix the login", Claude receives `"You are working on a Next.js app. fix the login"`.

Useful for giving each project persistent context without repeating yourself.

## Configuration & Storage

All state in `~/.claude/channels/hub/`:

```
~/.claude/channels/hub/
  config.json          # global settings
  sessions.json        # registered sessions
  inbox/               # temp file storage before moving to project
```

### config.json

```json
{
  "webPort": 3000,
  "telegramToken": "123:AAH...",
  "defaultTrust": "ask",
  "defaultUploadDir": "."
}
```

### sessions.json entry

```json
{
  "/home/user/frontend": {
    "name": "frontend",
    "trust": "auto-approve",
    "prefix": "You are working on a Next.js app.",
    "uploadDir": "uploads/",
    "managed": true
  }
}
```

## MCP Channel Protocol

The hub implements the same MCP channel protocol as the official Telegram plugin:

### Capabilities Declared

```typescript
{
  capabilities: {
    tools: {},
    experimental: {
      'claude/channel': {},
      'claude/channel/permission': {},
    },
  }
}
```

### Inbound (User → Claude)

Hub sends `notifications/claude/channel` to the target session's MCP connection:

```typescript
{
  method: 'notifications/claude/channel',
  params: {
    content: prefixedMessage,
    meta: {
      source: 'hub',
      frontend: 'telegram' | 'web' | 'cli',
      user: username,
      session: sessionName,
    }
  }
}
```

### Outbound (Claude → User)

Hub exposes `reply`, `react`, `edit_message` tools to each session. When Claude calls `reply`, hub routes the message to all connected frontends.

### Permission Relay

Hub receives `notifications/claude/channel/permission_request` from a session. Based on trust level:
- `auto-approve`: immediately sends back `notifications/claude/channel/permission` with `behavior: 'allow'`
- `ask`: forwards to all frontends with session name, waits for user response

## Tech Stack

- **Runtime:** Bun
- **MCP:** `@modelcontextprotocol/sdk`
- **Telegram:** `grammy`
- **Web server:** Bun built-in HTTP + WebSocket
- **PWA frontend:** Preact (lightweight) or vanilla HTML/CSS/JS
- **CLI:** Bun script communicating with hub via HTTP/WebSocket
- **Process management:** `child_process` for screen commands

No external databases, no heavy frameworks. `bun run daemon.ts` starts the daemon; `hub-shim.ts` is the tiny MCP bridge launched by Claude.

## Security

- Telegram access control: same pairing/allowlist model as official plugin
- Web PWA: local-only by default. For remote access, user configures tunnel (ngrok, tailscale)
- File uploads: validated, size-limited (50MB), restricted to configured upload directories
- Permission relay: only allowlisted Telegram users or authenticated web sessions can approve
- Hub state directory (`~/.claude/channels/hub/`) locked to owner (chmod 700)

## Constraints & Limitations

- Requires `--dangerously-load-development-channels` flag during research preview
- One Claude Code session per folder (enforced by hub)
- Telegram Bot API: no message history, 4096 char message limit (hub chunks automatically)
- Screen manager requires `screen` installed on the host
- Hub must run on the same machine as Claude Code sessions (stdio transport)
