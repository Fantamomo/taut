#!/bin/bash
# Sets up a Claude Code cloud environment for scripts/cloud.ts, the environment's setup script runs it
set -euo pipefail

npm install -g chrome-devtools-mcp@1.10.1
node -e '
const fs = require("fs")
const file = process.env.HOME + "/.claude.json"
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}
config.mcpServers = {
  ...config.mcpServers,
  "slack-browser": { type: "stdio", command: "chrome-devtools-mcp", args: ["--browserUrl", "http://127.0.0.1:9222"] },
}
fs.writeFileSync(file, JSON.stringify(config, null, 2))
'

mkdir -p ~/.claude
cat >~/.claude/CLAUDE.md <<'MD'
# Slack in this cloud environment

This VM can run Slack with Taut in Chromium, signed in as a throwaway test account.

- Run `node scripts/cloud.ts up`, then `eval` or `cdp` (and `shot` for a PNG). Pass `--name <name>` to every command when a subagent needs its own tab. Read `--help` for the rest.
- Each checkout, worktrees included, gets its own browser and dev server, so run the script from the checkout you're testing. Reload a tab to load a rebuild. The slack-browser MCP works for the main checkout only.
- Post only in the test account's self-DM unless the task names a channel, and mark test messages as tests.
MD
