import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Redirect state writes (sessions.json, config.json) away from the user's real
// ~/.claude/channels/hub so a test run can never clobber a running daemon.
// HUB_DIR is captured at config.ts module load, so this must run first via preload.
if (!process.env.HUB_DIR && !process.env.CLAUDE_PLUGIN_DATA) {
  process.env.HUB_DIR = mkdtempSync(join(tmpdir(), 'hub-test-'))
}
