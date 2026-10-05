# Atbash Safety Plugin for Claude Code

Atbash Safety checks Claude Code tool calls through a `PreToolUse` hook. The plugin bundles `@atbash/sdk@0.9.2` and its native bindings, configured for the Atbash production service at `atbash.ai`; users do not need to install the SDK separately or enter chain settings.

## Requirements

- Claude Code 1.0.33 or newer
- Node.js 22.13.0 or newer
- macOS arm64, Linux x64/arm64 (glibc), or Windows x64

## Install

Add this repository as a Claude Code marketplace and install the plugin:

```bash
claude plugin marketplace add Atbash-Ai/atbash-claude-plugin
claude plugin install atbash@atbash-ai
```

Inside Claude Code, the equivalent commands are:

```text
/plugin marketplace add Atbash-Ai/atbash-claude-plugin
/plugin install atbash@atbash-ai
```

To update later:

```bash
claude plugin marketplace update atbash-ai
claude plugin update atbash@atbash-ai
```

The installed plugin includes the SDK runtime and native bindings. No npm install or local build is needed for normal use.

## Set up an agent

Invoke the `atbash-setup` skill and ask Claude Code to start setup. The skill starts a short-lived onboarding session and provides a Connect Atbash link. Sign in and verify your wallet in the browser, then review and approve the exact account, organization, plan, and agent changes. The helper finishes setup and saves the agent key locally under `~/.config/atbash/` with restricted permissions. For an existing agent, it opens a local form for the key; the key is not sent to the dashboard or chat.

Use the `atbash-manage` skill for later name, purpose, risk, or active-state changes. Each change requires a fresh browser authorization.

## Check status and test

After setup, start a new Claude Code session and review the Atbash hook with `/hooks`. Check the local agent status from a source checkout with:

```bash
npm run status --workspace @atbash/claude-plugin
```

Try a harmless request such as listing the current directory. An `ALLOW` decision lets the call run; `HOLD`, `BLOCK`, invalid configuration, and service errors block it.

## Legacy manual configuration

The guided setup is recommended. If you need to configure an existing agent manually, use `~/.config/atbash/config.json` or environment variables in the process that launches Claude Code:

```json
{
  "agentKey": "<your-agent-private-key>",
  "orgName": "<your-exact-organization-name>"
}
```

Never put a private key in a prompt, plugin manifest, committed file, or shell history. The plugin reads the key locally and never uploads the configuration to an MCP service.

## Build from source

```bash
npm ci
npm run verify
npm run build:marketplace
```

`build:marketplace` regenerates the committed runtime from the pinned SDK version. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) for development and security information.
