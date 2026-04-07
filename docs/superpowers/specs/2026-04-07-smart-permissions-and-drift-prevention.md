# Smart Permissions & Drift Prevention — Design Spec

## Overview

Two related pain points solved together:

1. **Approval fatigue** — Channelhub currently forwards every tool permission prompt to the user. That means interruptions for trivial things like `Read` or `Glob`, and the user has to sit at their phone approving routine actions. Work halts until the user responds.

2. **Claude drift** — Claude Code loses focus on project rules during long sessions. Instructions in `CLAUDE.md` are read once and forgotten. Reminders like "this MCP is dev, not prod" or "no shortcuts when fixing bugs" have to be re-stated by the user, often after Claude has already made a mistake.

Both problems share a common solution: **channelhub sits between the user and Claude**, so it can inspect messages flowing in both directions and make intelligent decisions on the user's behalf.

## Architectural Principle: Sidecar Claude

Channelhub uses two different "Claudes":

| Role | Implementation | Purpose |
|------|---------------|---------|
| **Main Claude** | Full Claude Code session (MCP channel) | User-facing work with project context, persistent memory, tools, skills |
| **Sidecar Claude** | `claude --bare --print` subprocess | Stateless, fast, no project context — answers quick yes/no questions for the daemon |

The sidecar is a classification tool, not a user-facing session. Each call is fresh. It costs nothing beyond the user's existing subscription. It's used for:

- Deciding if a Bash command is dangerous
- Checking if Claude's reply violates project rules
- Summarizing session activity
- Routing messages to the right session
- Generating natural correction messages when drift is detected

## Feature 1: Smart Permission Classification

### Tool Categories

Each permission request is classified into one of four buckets:

| Category | Examples | Default Behavior |
|----------|----------|------------------|
| **Silent** | `Read`, `Glob`, `Grep`, `LS`, `TodoWrite`, `TaskOutput`, `WebFetch`, `WebSearch` | Auto-allow instantly. Not logged in user-facing timeline. |
| **Logged** | `Edit`/`Write` within project, `Bash` with benign commands (`ls`, `cat`, `npm test`, `git status`) | Auto-allow. Recorded in the session activity log so user can see what happened. |
| **Review** | `Edit`/`Write` outside project, `Bash` with commands needing judgment (`npm install`, `pip install`, `docker run`) | Auto-allow IF session trust is `auto`, else escalate to user. |
| **Dangerous** | `Bash` with `rm -rf /`, `sudo`, `drop table`, `git push --force`, `chmod 777`, `curl ... \| sh` | Always escalate to user regardless of trust level. |

### Classification Layers

Classification runs as a 3-layer fast-to-slow pipeline:

1. **L1 — Static map** (~0.1ms): Known tool names map directly to a category. `Read` → Silent. `WebFetch` → Silent. `Bash` → needs deeper inspection.

2. **L2 — Regex rules** (~1ms): For `Bash`, `Write`, `Edit`, run pattern checks on the arguments:
   - `rm\s+-rf\s+/`, `sudo`, `chmod\s+777`, `git\s+push\s+.*--force`, `drop\s+(table|database)`, `truncate\s+table`, `>\s*/dev/sd`, `mkfs`, `dd\s+if=`, `eval\s*\(`, `curl.*\|\s*(bash|sh)`
   - If any dangerous pattern matches → **Dangerous**, escalate.
   - If only benign patterns match → Logged, auto-allow.
   - Otherwise → fall through to L3.

3. **L3 — Sidecar Claude** (~1–3s, cached): Ambiguous cases go to sidecar Claude with a structured prompt:
   ```
   Classify this tool use as one of: SILENT, LOGGED, REVIEW, DANGEROUS.
   Answer in this exact format: CATEGORY|one-line-reason
   
   Tool: Bash
   Command: npm install --save-dev @types/node
   Project: /home/user/frontend
   ```
   → `LOGGED|standard dev dependency install in project`

### Classification Cache

Sidecar calls are cached by (tool_name, normalized_args_hash). Repeated identical requests hit the cache and return instantly. Cache expires after 1 hour to handle project changes. Cache is per-session, not global, so `rm -rf node_modules` in a project-root session stays safe while the same command elsewhere gets re-evaluated.

### Trust Levels (per session)

The existing `trust` field on `SessionState` gains new values:

| Trust Level | Silent | Logged | Review | Dangerous |
|-------------|--------|--------|--------|-----------|
| `strict` | Allow | Escalate | Escalate | Escalate |
| `ask` (default) | Allow | Allow | Escalate | Escalate |
| `auto` | Allow | Allow | Allow | Escalate |
| `yolo` | Allow | Allow | Allow | Allow (with warning log) |

`strict` is for sensitive projects where even file writes should be reviewed.
`yolo` is for disposable scratch sessions where nothing matters.

## Feature 2: Drift Prevention

Three related mechanisms to keep Claude on track.

### Persistent Rules (per session)

Users define rules that get automatically injected on every message they send to a session.

```
/rules awafi no shortcuts when fixing bugs, use TDD workflow, no bare commits
```

On each outbound message from the user, channelhub silently appends:
```
[Session Rules: no shortcuts when fixing bugs, use TDD workflow, no bare commits]
```

This is similar to the existing `prefix` feature but structured as rules with their own storage, management commands, and visibility in the dashboard. Prefix remains for free-form prepending; rules are for behavioral constraints.

### Context Facts (per session)

Facts are runtime truths about the project that Claude needs to know:

```
/fact awafi the database MCP is dev, not prod. Always check schema before writing.
/fact awafi Bob owns the auth module. Don't touch src/auth/ without asking.
/fact awafi this branch cannot be force-pushed — it's shared with the mobile team.
```

Facts are appended to every outbound message after rules:
```
[Session Rules: ...]
[Facts: the database MCP is dev, not prod. Bob owns auth module. No force-push on this branch.]
```

Facts differ from rules semantically but share the same injection mechanism. The distinction matters for the dashboard UI (rules are behavioral, facts are informational) but the wire format is identical.

### Drift Detection

After every reply Claude sends back through the channel, channelhub runs a drift check:

1. **Fast path — regex scan**: look for anti-pattern phrases (`quick fix`, `let me just`, `TODO`, `for now`, `I'll ignore`, `commenting out`, `skip for now`, `hack`). If none match, skip the slow path.

2. **Slow path — sidecar judgment**: if regex matched or every N messages (configurable), ask sidecar Claude:
   ```
   A Claude Code session has these rules: [rules]
   And these facts: [facts]
   
   Claude just replied:
   ---
   {reply-excerpt-last-500-chars}
   ---
   
   Does this reply violate any rules or ignore any facts?
   Answer: YES|<rule>|<1-sentence-correction> or NO
   ```

3. **Correction injection**: if sidecar says YES, channelhub immediately sends a correction message to the session through the channel:
   ```
   ⚠️ Drift check: {rule}. {correction}
   ```

The correction comes from sidecar Claude, so it's natural-language and context-aware. The main Claude sees it as a new user message and course-corrects.

### Drift Rate Limiting

To avoid runaway feedback loops:
- Max 1 correction per 30 seconds per session.
- Sidecar drift checks are debounced — only runs after Claude's reply stream ends, not on every token.
- If three corrections fire within 5 minutes, channelhub escalates to the user with "Claude keeps drifting on rule X — please intervene."

## Storage

New fields on `SessionConfig`:

```typescript
export type TrustLevel = 'strict' | 'ask' | 'auto' | 'yolo'
// was: 'ask' | 'auto-approve'

export type SessionConfig = {
  name: string
  trust: TrustLevel
  prefix: string              // existing — free-form prepend
  uploadDir: string
  managed: boolean
  teamIndex: number
  teamSize: number
  rules: string[]             // NEW — behavioral constraints
  facts: string[]             // NEW — runtime context
}
```

Backwards compatibility: migrate `auto-approve` → `auto` on load.

Classification cache lives in memory only — not persisted. Rebuilt on daemon restart.

## Module Layout

```
src/
  sidecar.ts             # NEW — wraps `claude --bare --print` with timeout + cache
  classifier.ts          # NEW — 3-layer permission classification (L1 static, L2 regex, L3 sidecar)
  drift-detector.ts      # NEW — regex + sidecar drift check after Claude replies
  rules-engine.ts        # NEW — rules/facts injection on outbound messages
  permission-engine.ts   # EXTEND — use classifier + honor new trust levels
  message-router.ts      # EXTEND — inject rules/facts via rules-engine on outbound
  daemon.ts              # EXTEND — wire drift-detector to tool_call "reply" events
  types.ts               # EXTEND — new TrustLevel values, rules/facts fields
  frontends/telegram.ts  # EXTEND — /rules, /facts, /fact, /trust with new levels
  frontends/web.ts       # EXTEND — rules/facts UI, classification log view
```

## User Interface Changes

### Telegram Commands

| Command | Description |
|---------|-------------|
| `/rules <name> <text>` | Add a rule to session. Multiple rules separated by commas. |
| `/rules <name>` | Show current rules for a session. |
| `/rules <name> clear` | Remove all rules. |
| `/fact <name> <text>` | Add a context fact. |
| `/facts <name>` | Show current facts. |
| `/facts <name> clear` | Remove all facts. |
| `/trust <name> strict\|ask\|auto\|yolo` | Set session trust level (existing, extended). |

### Web Dashboard

- **Per-session panel** shows rules and facts as editable lists (add/remove with buttons).
- **Activity log** for each session showing all tool uses classified as `Logged` or higher, with the classification reason visible on hover.
- **Drift events** appear in the activity log with a warning icon and the correction that was sent.
- **Trust level selector** in the session header replaces the current toggle.

## Hub vs Claude Responsibilities

| Responsibility | Hub | Main Claude | Sidecar Claude |
|---|---|---|---|
| Classify permission request | ✅ (L1/L2) | — | ✅ (L3 ambiguous) |
| Send allow/deny | ✅ | — | — |
| Execute the tool | — | ✅ | — |
| Apply rules to messages | ✅ | — | — |
| Detect drift in replies | ✅ (regex) | — | ✅ (semantic) |
| Generate correction text | — | — | ✅ |
| Act on corrections | — | ✅ | — |

Channelhub is the policy layer. Main Claude does the work. Sidecar Claude is the advisor.

## Rollout Plan

Phase 1 ships in three increments so each can be validated independently:

**1a. Classification & Trust Levels**
- New `TrustLevel` type
- Static + regex classifier (no sidecar yet)
- Existing permission engine uses classifier
- `/trust` command updated

**1b. Sidecar Integration**
- `sidecar.ts` module with process pool and cache
- L3 layer added to classifier
- Drift detector regex layer

**1c. Rules, Facts & Sidecar Drift**
- `rules-engine.ts` with injection
- `/rules` and `/fact` commands
- Web UI for rules/facts
- Sidecar-based drift detection with correction injection

Each increment is shippable — 1a alone already dramatically reduces approval fatigue.

## Already Working (not in scope for this phase)

- **Voice transcription** — Telegram and mobile keyboards already do this client-side. Voice messages arrive as text.
- **File uploads** — photos, screenshots, and documents can already be sent via Telegram or the web UI and are saved to the active session's project folder. Claude reads them from the path in the notification.

## Non-Goals

- **Not building scheduled messages** — separate phase.
- **Not building event reactions (webhook → Claude)** — separate phase.
- **Not doing session replay/timeline beyond the basic activity log** — the activity log is a side effect of classification, not a standalone feature.
- **Not touching agent teams logic** — existing behavior preserved.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Sidecar latency delays permission responses | L1/L2 handle 80% of cases in <1ms. L3 runs only on ambiguous cases, target <2s with cache. User never waits more than they would for the manual approval flow. |
| Sidecar wrong answers | Conservative defaults: if sidecar output is malformed or times out, fall back to "escalate to user". Never auto-allow on uncertainty. |
| Rules injection confuses Claude | Rules are wrapped in `[Session Rules: ...]` brackets at the end of user messages. Format is explicit enough that Claude treats them as constraints, not as part of the user's request. |
| Drift corrections flood the session | Rate-limited: 1 correction per 30s, max 3 per 5 minutes before escalating to user. |
| Classification cache goes stale | 1-hour TTL. Per-session scope prevents cross-session poisoning. |
| Sidecar subprocess overhead | Single long-lived sidecar process with stdin/stdout pipe — avoid spawning a new `claude --bare` per call. Batched requests where possible. |
