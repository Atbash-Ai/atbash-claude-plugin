# Atbash Safety Plugin for Claude Code

Atbash Safety checks Claude Code tool calls through a `PreToolUse` hook. The `dev` branch bundles `@atbash/sdk@0.10.10-dev.0` and its native bindings. The bundled SDK is configured for the Atbash development service; users do not need to install the SDK separately or enter chain settings.

## Requirements

- Claude Code 1.0.33 or newer
- Node.js 22.13.0 or newer
- macOS arm64, Linux x64/arm64 (glibc), or Windows x64

## Install the development plugin

Claude Code marketplace sources do not select a Git branch in the install command. Clone the `dev` branch, add that checkout as a local marketplace, and install the plugin:

```bash
git clone --branch dev --depth 1 https://github.com/Atbash-Ai/atbash-claude-plugin.git ~/atbash-claude-plugin-dev
claude plugin marketplace add ~/atbash-claude-plugin-dev
claude plugin install atbash@atbash-ai
```

Inside Claude Code, the equivalent commands are:

```text
/plugin marketplace add ~/atbash-claude-plugin-dev
/plugin install atbash@atbash-ai
```

To update the dev build later:

```bash
git -C ~/atbash-claude-plugin-dev pull --ff-only
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

## What the hook sends

With each tool call the hook sends the tool name, its arguments (secrets redacted by the SDK), and a short context: `source=claude-code`, the permission mode and, when present, the model.

The judge context is recorded on a public chain, so it never includes the working directory or the workspace folder name. A folder name can identify a client, and it is text a cloned repository controls. The permission mode is sent only when it is one of Claude Code's documented modes, and the model only when it looks like a model id (letters, digits and `. _ : / @ [ ] -`, at most 128 characters); anything else is sent as `other`, so repository settings cannot add text to the context. A 12-digit AWS account id inside a model ARN (for example a Bedrock inference profile) is sent as `account`. A custom model or gateway name that you chose yourself is sent as it is, so do not put client names in it.

Tool arguments are a different matter. Claude Code's file tools use absolute paths, so the arguments normally carry the full working directory, including your user name and folder names. Arguments and commands are sent as they are, to the judge and to its model provider, and are recorded on chain in plain text unless your organization enables encryption. Secret redaction is best-effort: it matches known secret patterns and cannot catch everything. Records written by earlier plugin versions, which included `workspace=<folder name>` in the context, stay on chain.

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

`build:marketplace` regenerates the committed runtime from the pinned development SDK version. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) for development and security information.
