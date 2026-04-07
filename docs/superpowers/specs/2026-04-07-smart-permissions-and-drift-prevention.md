# Phase 1: Smart Sessions — Design Spec

## Overview

Phase 1 is a coordinated set of features that make Claude Code sessions smarter, less interrupting, and harder to derail. Everything in this phase is built around one organizing concept: **profiles**.

A profile is a reusable bundle of session configuration: trust level, behavioral rules, runtime facts, reply style per frontend, and verification commands. When a user spawns a session they pick a profile, and the profile's fields become the session's starting config. Users can override individual fields later — the profile is a baseline, not a lock.

Profiles make it possible to define "how we work on production backend" once and apply it to every session a teammate spawns for that project. Without profiles, the same rules and facts would have to be re-typed for every session, which defeats the purpose of having them at all.

## Problems Solved

1. **Approval fatigue** — Channelhub currently forwards every tool permission prompt. Work halts for trivial things like `Read` or `Glob` that should be auto-allowed.

2. **Claude drift** — Claude loses focus on project rules during long sessions. `CLAUDE.md` is read once then forgotten. Reminders have to be manually re-stated.

3. **False "done" claims** — Claude writes code and says "done" without actually running tests. Users discover failures later.

4. **Mobile file blindness** — Claude replies with bare file paths ("spec saved to docs/...") which mobile users can't open. No formatting, no emoji, no inline content.

5. **Config sprawl** — Rules, facts, trust levels, and verification commands have to be reconfigured for every new session, often from scratch.

## Architectural Principle: Sidecar Claude

Channelhub uses two different Claude processes:

| Role | Implementation | Purpose |
|------|---------------|---------|
| **Main Claude** | Full Claude Code session over MCP channel | User-facing work with project context, persistent memory, tools, skills |
| **Sidecar Claude** | `claude --bare --print` subprocess | Stateless, fast, no project context — answers quick yes/no questions for the daemon |

The sidecar is a classification tool, not a user-facing session. Each call is fresh and self-contained. It costs nothing beyond the user's existing subscription. Used for:

- Classifying ambiguous permission requests (is this Bash command dangerous?)
- Judging drift (does this reply violate the rules?)
- Generating natural correction messages
- Interpreting long verification output
- Routing messages to the right session when unspecified

## Feature 1: Profile System (foundation)

### Profile Structure

```typescript
type Profile = {
  name: string                    // "prod-backend", "dev-frontend"
  description?: string
  trust: TrustLevel               // strict | ask | auto | yolo
  rules: string[]                 // behavioral constraints
  facts: string[]                 // runtime context
  prefix: string                  // free-form message prefix
  channelOverrides?: Partial<Record<FrontendSource, string>>
  verification?: {
    commands: string[]            // e.g., ["npm test", "npm run lint"]
    triggerPhrases?: string[]     // phrases that trigger verification (defaults: "done", "finished", "implemented")
    timeoutSec?: number           // default 120
  }
}
```

### Storage

Profiles are stored globally in `~/.claude/channels/hub/profiles.json` (one file, array of profiles). Sessions reference the applied profile name but hold their own copy of the fields — so deleting or editing a profile doesn't break running sessions. Propagating edits is a separate concern for a future phase.

### Built-in Profiles

Ship with four battle-tested profiles users can pick immediately:

**`careful`** — production work
- trust: `strict`
- rules: "no shortcuts, no hacks, always test before claiming done, no force-push, no history rewrite, no deploys without approval"
- verification: auto-detected from project (npm test, cargo test, pytest)

**`tdd`** — test-driven development
- trust: `ask`
- rules: "write failing test first, never skip tests, never comment out tests, no implementation without a test"
- verification: required on every completion claim

**`docs`** — documentation work
- trust: `ask`
- rules: "use markdown with H2/H3 hierarchy, all code examples must be runnable, add TOC for docs over 500 words, no jargon without definition"

**`yolo`** — disposable experiments
- trust: `yolo`
- rules: []
- verification: disabled

### Commands

| Command | Description |
|---------|-------------|
| `/profiles` | List all profiles |
| `/profile <name>` | Show profile details |
| `/profile create <name>` | Create new profile (starts blank or from current session) |
| `/profile edit <name>` | Edit a profile (opens the web UI for structured editing) |
| `/profile delete <name>` | Delete a profile |
| `/profile export <name>` | Get JSON export of profile (for sharing) |
| `/profile import` | Import a profile from JSON (paste in reply) |

### Spawn integration

Web spawn dialog gains a profile dropdown. Telegram `/spawn` gains an optional `--profile <name>` flag. CLI `channelhub spawn` gains the same flag. No profile selected means "blank session with defaults", which is the current behavior.

### Sharing

Profiles export and import as JSON. Users share them via git, slack, or any text channel. A team lead defines `prod-backend` once, exports the JSON, teammates import it. Future enhancement: profile sync via git URL.

## Feature 2: Smart Permission Classification

Every permission request is classified into one of four categories:

| Category | Examples | Default Behavior |
|----------|----------|------------------|
| **Silent** | `Read`, `Glob`, `Grep`, `LS`, `TodoWrite`, `TaskOutput`, `WebFetch`, `WebSearch` | Auto-allow instantly, not logged in timeline |
| **Logged** | `Edit`/`Write` within project, benign `Bash` (`ls`, `cat`, `npm test`, `git status`) | Auto-allow, recorded in activity log |
| **Review** | `Edit`/`Write` outside project, `Bash` with installs (`npm install`, `pip install`, `docker run`) | Auto-allow if trust=auto, else escalate |
| **Dangerous** | `Bash` with `rm -rf /`, `sudo`, `drop table`, `git push --force`, `chmod 777`, `curl \| sh` | Always escalate regardless of trust |

### Trust Levels

The session trust level (inherited from its profile) decides what happens to Logged and Review categories:

| Trust Level | Silent | Logged | Review | Dangerous |
|-------------|--------|--------|--------|-----------|
| `strict` | Allow | Escalate | Escalate | Escalate |
| `ask` (default) | Allow | Allow | Escalate | Escalate |
| `auto` | Allow | Allow | Allow | Escalate |
| `yolo` | Allow | Allow | Allow | Allow (with warning log) |

Backwards compatibility: existing `auto-approve` migrates to `auto` on first load.

### Classification Pipeline

Runs as a 3-layer fast-to-slow pipeline:

1. **L1 — Static map** (~0.1ms): Known tool names map directly to a category.
2. **L2 — Regex rules** (~1ms): For `Bash`, `Write`, `Edit`, run pattern checks on arguments:
   - Dangerous patterns: `rm\s+-rf\s+/`, `sudo`, `chmod\s+777`, `git\s+push\s+.*--force`, `drop\s+(table|database)`, `truncate`, `>\s*/dev/sd`, `mkfs`, `dd\s+if=`, `eval\s*\(`, `curl.*\|\s*(bash|sh)`
   - Benign patterns: `ls`, `cat`, `echo`, `git status`, `npm test`, `cargo test`, `pytest` (in project dir)
3. **L3 — Sidecar Claude** (~1-3s, cached): Ambiguous cases get semantic judgment from sidecar with a structured prompt.

### Classification Cache

Sidecar results cached by `(tool_name, normalized_args_hash)` with 1-hour TTL, per-session scope. Repeated identical requests hit the cache instantly.

## Feature 3: Drift Prevention

### Injection Engine

On every outbound message from a user to a session, channelhub prepends three context blocks in order:

```
[Channel: {frontend-specific instructions}]
[Session Rules: {rules from profile + session overrides}]
[Facts: {facts from profile + session overrides}]

{original user message}
```

Claude sees all three blocks as part of the user's message and respects them.

### Channel Instructions (built-in defaults)

Claude Code doesn't know it's talking to a phone through Telegram or a browser through the web dashboard. Ship with per-frontend defaults:

**Telegram** (mobile-first):
> You are replying on Telegram mobile. Use markdown formatting, emoji prefixes (✅ ❌ ⚠️ 🔄 📝), bold for emphasis, and fenced code blocks. When you create, save, or reference a file (especially .md specs, configs, or new code files), paste the full file contents in your reply — mobile users cannot browse the filesystem. Keep replies concise but complete.

**Web**:
> You are replying on the web dashboard. Use markdown, code blocks, tables, and emoji. For files, show a summary or diff; long content is fine since the dashboard has scroll. Prefer structured output over walls of text.

**CLI**:
> You are replying via CLI. Plain text only, no markdown, no emoji. Keep output terminal-friendly and concise.

Profiles can override these via `channelOverrides` field.

### Auto-fetch Fallback

If Claude still emits bare file paths despite channel instructions, channelhub scans replies for "saved to:", "written to:", "spec saved:" patterns followed by a file path. If the file exists, is under 50KB, and has a safe extension (md, json, yaml, ts, js, py, go, rs, txt), channelhub sends a follow-up channel message with the content as a code block. One auto-fetch per reply maximum.

### Rules (behavioral constraints)

Rules come from the profile's `rules` array plus any session-level additions. Users add them via `/rules <session> <text>`. Rules are injected on every inbound message.

Example profile rules for `prod-backend`:
- "No shortcuts, no hacks, always root-cause bugs"
- "Never force-push or rewrite history on this branch"
- "Always run tests before claiming done"

### Facts (runtime context)

Facts differ from rules semantically — they're truths about the project, not behavioral constraints. Examples:
- "The database MCP is pointing at dev, not prod. Always check the schema first."
- "Bob owns the auth module. Don't touch src/auth/ without asking."
- "This branch is shared with the mobile team. No force-push."

Facts are injected on every inbound message alongside rules.

### Drift Detection

After every reply Claude sends back through the channel, channelhub runs a drift check:

1. **Fast path — regex scan**: Look for anti-patterns (`quick fix`, `let me just`, `TODO`, `for now`, `I'll ignore`, `commenting out`, `hack`, `skip for now`). If none match, skip the slow path.

2. **Slow path — sidecar judgment**: When regex matches or every N messages (configurable), ask sidecar Claude:
   ```
   A Claude Code session has these rules: {rules}
   And these facts: {facts}
   
   Claude just replied:
   ---
   {reply-last-500-chars}
   ---
   
   Does this reply violate any rules or ignore any facts?
   Answer: YES|{rule}|{one-sentence-correction} or NO
   ```

3. **Correction injection**: If sidecar says YES, channelhub sends a correction message to the session:
   > ⚠️ Drift check: {rule}. {correction}

The correction comes from sidecar Claude, so it's natural and context-aware. The main Claude sees it as a new user message and course-corrects.

### Drift Rate Limiting

- Max 1 correction per 30 seconds per session
- Sidecar drift checks debounced — only run after Claude's reply stream ends
- If 3 corrections fire within 5 minutes, escalate to user: "Claude keeps drifting on rule X — please intervene"

## Feature 4: Verification Runner

Claude's habit of saying "done" without running tests is solved with deterministic subprocess verification defined in the profile.

### Trigger

Channelhub scans Claude's replies for completion phrases (from the profile's `triggerPhrases` or defaults: `done`, `finished`, `completed`, `implemented`, `all set`). When a trigger phrase is detected and the profile has verification commands defined, the runner kicks in.

### Execution

The runner executes profile commands sequentially in the session's project directory:

```bash
cd /home/user/project
npm test && npm run lint && npm run typecheck
```

Each command has a timeout (default 120s). Stdout and stderr are captured.

### Result Injection

**All pass:**
> ✅ **Verified done** — `npm test` passed (15 tests), lint clean, typecheck clean.

**Any fail:**
The failing output is sent back to the session as a channel message:
```
⚠️ Verification failed. You said done but:

$ npm test
FAIL src/auth.test.ts
  ✗ should reject expired tokens (12ms)
    Expected 401, received 200

Please fix and run verification again.
```

If the output is over 2000 chars, sidecar Claude summarizes it first ("tldr: 3 tests failing in auth.test.ts, all related to token expiration").

Claude sees the failure as a new user message and iterates. Verification runs again on the next completion claim.

### Proactive "no tests run" warning

Channelhub tracks whether Claude invoked Bash with a test command during the session. If Claude claims "done" without ever running a test, channelhub intervenes:
> ⚠️ You said done, but you haven't run any tests in this session. Running verification now...

### Project-type auto-detection

When creating a profile, channelhub can pre-populate `verification.commands` based on detected project type:

| Detected file | Default commands |
|---------------|------------------|
| `package.json` | `npm test`, `npm run lint` (if script exists), `npm run typecheck` (if script exists) |
| `Cargo.toml` | `cargo check`, `cargo test`, `cargo clippy` |
| `pyproject.toml` | `pytest`, `ruff check` (if installed) |
| `go.mod` | `go build ./...`, `go test ./...` |
| `tsconfig.json` | `tsc --noEmit` |

## Storage

Add to `SessionConfig`:

```typescript
export type TrustLevel = 'strict' | 'ask' | 'auto' | 'yolo'

export type SessionConfig = {
  // existing fields
  name: string
  prefix: string
  uploadDir: string
  managed: boolean
  teamIndex: number
  teamSize: number

  // new / changed
  trust: TrustLevel             // was 'ask' | 'auto-approve'
  appliedProfile?: string       // NEW — name of profile used at spawn
  rules: string[]               // NEW — from profile, can be extended per session
  facts: string[]               // NEW — from profile, can be extended per session
  channelOverrides?: Partial<Record<FrontendSource, string>>  // NEW
  verification?: {              // NEW
    commands: string[]
    triggerPhrases?: string[]
    timeoutSec?: number
  }
}
```

New file: `~/.claude/channels/hub/profiles.json` with the array of profiles.

The classification cache and drift-check state are in-memory only, not persisted.

## Module Layout

```
src/
  profile-manager.ts     # NEW — load/save profiles, apply to session, export/import
  sidecar.ts             # NEW — wraps `claude --bare --print` with long-lived process + cache
  classifier.ts          # NEW — 3-layer permission classification
  drift-detector.ts      # NEW — regex + sidecar drift check after Claude replies
  rules-engine.ts        # NEW — channel/rules/facts injection on outbound messages
  verification-runner.ts # NEW — subprocess verification on completion phrases
  permission-engine.ts   # EXTEND — use classifier + honor new trust levels
  message-router.ts      # EXTEND — inject context via rules-engine
  session-registry.ts    # EXTEND — new fields, profile application
  daemon.ts              # EXTEND — wire drift-detector + verification-runner to tool_call events
  types.ts               # EXTEND — new TrustLevel, Profile, extended SessionConfig
  frontends/telegram.ts  # EXTEND — /profile, /rules, /fact, /channel, /verify commands
  frontends/web.ts       # EXTEND — profile manager UI, spawn profile picker, activity log
```

## User Interface

### Telegram Commands

| Command | Description |
|---------|-------------|
| `/profiles` | List all profiles |
| `/profile <name>` | Show profile details |
| `/profile create <name>` | Create new profile |
| `/profile delete <name>` | Delete a profile |
| `/profile export <name>` | Export profile as JSON |
| `/profile import` | Import profile from JSON reply |
| `/spawn <name> <path> [--profile <p>] [team-size]` | Spawn with optional profile |
| `/rules <session>` | Show session rules |
| `/rules <session> <text>` | Add rule(s) to session |
| `/rules <session> clear` | Clear session rules |
| `/fact <session> <text>` | Add fact to session |
| `/facts <session>` | Show session facts |
| `/channel <session> <text>` | Override channel instructions |
| `/channel <session> reset` | Revert to default channel instructions |
| `/trust <session> strict\|ask\|auto\|yolo` | Set trust level |
| `/verify <session>` | Manually trigger verification |

### Web Dashboard

- **Profile manager page**: list, create, edit, delete, import, export profiles
- **Spawn dialog**: profile dropdown + per-field override checkboxes
- **Session panel**: editable rules, facts, channel override, verification config
- **Activity log**: all tool uses classified as Logged/Review/Dangerous with classification reason
- **Drift events** in the activity log with warning icon and correction text
- **Verification results** in the activity log with pass/fail badges

## Hub vs Claude Responsibilities

| Responsibility | Hub | Main Claude | Sidecar Claude |
|---|---|---|---|
| Define profiles | ✅ | — | — |
| Apply profile to session | ✅ | — | — |
| Inject rules/facts/channel on messages | ✅ | — | — |
| Classify permission (L1/L2) | ✅ | — | — |
| Classify permission (L3 ambiguous) | ✅ (orchestrates) | — | ✅ |
| Allow/deny tool use | ✅ | — | — |
| Execute the tool | — | ✅ | — |
| Detect drift (regex) | ✅ | — | — |
| Detect drift (semantic) | ✅ (orchestrates) | — | ✅ |
| Generate correction text | — | — | ✅ |
| Run verification commands | ✅ (subprocess) | — | — |
| Summarize verification output | ✅ (orchestrates) | — | ✅ (if long) |
| Apply corrections | — | ✅ | — |

## Rollout Plan

Phase 1 ships in five sub-phases. Each is independently shippable and delivers value on its own.

### 1a — Profile System + Trust Levels
- `Profile` type, `profile-manager.ts`, `profiles.json` storage
- New `TrustLevel` values (`strict`/`ask`/`auto`/`yolo`), migration from old values
- `/profile` and `/profiles` commands (Telegram, CLI)
- Web: profile manager page, spawn dialog profile dropdown
- Built-in profiles: `careful`, `tdd`, `docs`, `yolo`
- Spawn integration: `--profile` flag applies profile fields to new session

### 1b — Smart Permission Classification (L1 + L2)
- `classifier.ts` with static map and regex rules
- Extend `permission-engine.ts` to honor new trust levels
- Activity log for Logged/Review events (web UI only, Telegram silent)
- No sidecar yet — ambiguous cases escalate to user

### 1c — Sidecar Claude + L3 Classification
- `sidecar.ts` with long-lived process pool and in-memory cache
- Add L3 layer to classifier for ambiguous cases
- Add `/sidecar status` diagnostic command

### 1d — Rules, Facts, Channel Instructions, Drift Detection
- `rules-engine.ts` with injection pipeline
- Built-in channel instructions per frontend
- `/rules`, `/fact`, `/channel` commands
- Auto-fetch fallback for bare file paths
- `drift-detector.ts` with regex + sidecar layers
- Rate-limited correction injection

### 1e — Verification Runner
- `verification-runner.ts` with completion phrase detection
- Subprocess execution with timeout
- Auto-detect project type for default verification commands
- "No tests run" proactive warning
- Long-output summarization via sidecar

## Already Working (not in this phase)

- Voice transcription — Telegram and mobile keyboards already transcribe client-side
- File uploads — photos, screenshots, documents already saved to project folder

## Non-Goals

- Scheduled messages — separate phase
- Event reactions / webhook triggers — separate phase
- Session timeline / replay beyond the basic activity log — separate phase
- Agent teams changes — existing behavior preserved
- Profile sync across machines via git URL — future enhancement

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Sidecar latency slows permission responses | L1/L2 handle ~80% of cases in <1ms. L3 only runs for ambiguous cases with <2s target and cache. Single long-lived sidecar process avoids per-call startup. |
| Sidecar wrong answers | Conservative fallback: malformed output or timeout → "escalate to user". Never auto-allow on uncertainty. |
| Injection confuses Claude | Structured bracket format `[Channel: ...] [Session Rules: ...] [Facts: ...]` is explicit enough for Claude to treat as constraints. Tested in the prompt templates. |
| Drift corrections create feedback loops | Rate-limited: 1 per 30s, max 3 per 5 minutes before escalating to user. |
| Verification commands hang | Per-command timeout (default 120s), killed on exceed. Failure surfaced as "verification timed out". |
| Profile deletion breaks sessions | Sessions hold their own copy of profile fields at spawn time. Profile deletion only affects future spawns. |
| Classification cache stale | 1-hour TTL, per-session scope. Rebuild on daemon restart. |
| Built-in profiles don't match user's project | User can always pick "None" or edit/clone a built-in into a custom profile. |
