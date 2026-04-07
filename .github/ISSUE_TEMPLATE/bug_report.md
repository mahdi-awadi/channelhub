---
name: Bug report
about: Something isn't working
title: '[BUG] '
labels: bug
---

## Description
A clear description of what the bug is.

## Steps to Reproduce
1. Start daemon with `channelhub start`
2. Connect Claude with `...`
3. Send message '...'
4. See error

## Expected Behavior
What should happen.

## Actual Behavior
What actually happens.

## Environment
- OS: [e.g. Ubuntu 22.04, macOS 14]
- Bun version: [`bun --version`]
- Claude Code version: [`claude --version`]
- ChannelHub commit: [`git -C ~/.channelhub rev-parse HEAD`]

## Logs
```
Paste relevant daemon logs from: tmux attach -t hub-daemon
```

## Additional Context
Any other context about the problem.
