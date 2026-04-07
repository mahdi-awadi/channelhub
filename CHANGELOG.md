# Changelog

All notable changes to ChannelHub will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-beta.1] - 2026-04-07

### Added
- Initial public release
- Multi-session daemon with Unix socket transport
- MCP shim bridging Claude Code stdio to daemon
- Telegram bot frontend with commands (list, spawn, kill, trust, team, etc.)
- Web dashboard with Telegram login, chat view, file upload
- CLI frontend (`channelhub` command)
- Native MCP permission relay (Allow / Always Allow / Deny)
- Per-session trust levels (ask / auto-approve)
- Agent teams support — spawn coordinated Claude sessions with team protocol
- Task monitoring — reads Claude's agent team task files
- Photo/document upload via Telegram to project folders
- Prompt tag toggles (Superpowers, TDD, Concise, etc.)
- Directory browser in spawn dialog
- Auto-detection of Claude agent teammates (skipped from hub registry)
- Reconnect logic — sessions reuse disconnected slots, no ghost duplicates
- `install.sh` one-liner installer with prerequisite checks
- Plugin manifest (`plugin.json`) and marketplace manifest for Claude Code
- Skills (`configure`, `access`) for in-session setup help
- 65 tests covering registry, socket, router, permissions, screen, task monitor, frontends

[Unreleased]: https://github.com/mahdi-awadi/channelhub/compare/v0.1.0-beta.1...HEAD
[0.1.0-beta.1]: https://github.com/mahdi-awadi/channelhub/releases/tag/v0.1.0-beta.1
