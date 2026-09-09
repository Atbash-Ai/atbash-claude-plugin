---
name: atbash-setup
description: Configure, activate, verify, troubleshoot, or rotate credentials for the Atbash Safety plugin. Use when a user asks how to set up Atbash, enable or disable its hook, configure an organization or private key, check agent status, understand ALLOW/HOLD/BLOCK behavior, or fix configuration, registration, jailed-agent, endpoint, or service errors.
---

# Atbash Setup

Keep Atbash enforcement separate from this skill. The plugin's catch-all `PreToolUse` hook automatically judges supported tool calls whenever the plugin and its hook are enabled; do not decide case by case whether to invoke Atbash.

## Protect credentials

- Never ask the user to paste, upload, or reveal an Atbash private key in chat.
- Never read, print, log, inspect, or transmit the user's Atbash config file.
- Never place a private key in a prompt, tool argument, command-line argument, shell history, manifest, repository file, or `.env` file.
- Ask the user to edit the config locally themselves. If a private key has appeared in chat, logs, or version control, advise the user to revoke or rotate it before continuing.
- Explain that the SDK uses the private key locally for agent identity and cryptographic signing and derives the public key locally. The configuration file remains on the user's machine; the plugin does not operate a credential-holding MCP server.

## Configure before enabling the hook

Tell the user to create the SDK config outside the Claude Code conversation before enabling the plugin. The organization name is required and must exactly match the organization where the agent's derived public key is onboarded.

Use this JSON shape at `~/.config/atbash/config.json` on macOS/Linux or `%USERPROFILE%\.config\atbash\config.json` on Windows:

```json
{
  "agentKey": "<your-agent-private-key>",
  "orgName": "<your-exact-organization-name>"
}
```

Give the user these manual setup commands without executing them or asking for their resulting file contents.

macOS/Linux:

```bash
mkdir -p ~/.config/atbash
chmod 700 ~/.config/atbash
${EDITOR:-vi} ~/.config/atbash/config.json
chmod 600 ~/.config/atbash/config.json
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\.config\atbash"
notepad "$HOME\.config\atbash\config.json"
```

Environment variables `ATBASH_AGENT_KEY` and `ATBASH_ORG_NAME` are a session-only alternative. Prefer the config file for the Claude Code desktop app because environment changes do not reach an already-running desktop process.

If the already-enabled fail-closed hook prevents setup actions, tell the user to disable the Atbash plugin, complete configuration manually outside Claude Code, restart Claude Code, and re-enable the plugin.

## Activate or deactivate

Treat Atbash as active only when all of these are true:

1. The `atbash` plugin is installed and enabled.
2. The Atbash `PreToolUse` hook is loaded; the user can review it in `/hooks`.
3. Local Atbash credentials and organization configuration are valid.

To deactivate Atbash, tell the user to disable or uninstall the plugin from the `/plugin` menu (or `claude plugin disable atbash`). Do not describe deactivation as bypassing an individual verdict; it disables enforcement for subsequent tool calls.

## Verify and troubleshoot

After configuration and activation, use a harmless tool call such as listing the current directory to verify that the hook allows an ordinary action. Do not use destructive or privileged commands as tests.

If working from a source checkout, the user can run:

```bash
npm run status --workspace @atbash/claude-plugin
```

Interpret status results as follows:

- `ready`: configuration, registration, and service access are working.
- `configuration_error`: correct the local key, exact organization name, or optional endpoint settings.
- `agent_not_registered`: onboard the public key derived from this private key into the named organization.
- `agent_jailed`: resolve the agent state in Atbash before retrying.
- `service_error`: check connectivity, endpoint/chain settings, and Atbash service availability.

Never diagnose key mismatch by asking to inspect the private key. Ask the user to compare the locally derived public key with the public key registered in the Atbash dashboard.

## Explain verdicts

- `ALLOW` with `allow: true`: Claude Code continues the pending tool call.
- `HOLD`: Claude Code blocks this attempt pending operator review. After approval in Atbash, the user must explicitly retry the original request.
- `BLOCK`: Claude Code blocks the tool call.
- `ERROR`, timeout, malformed output, missing configuration, or inconsistent output: Claude Code blocks the tool call because the hook is fail closed.

Do not claim that the plugin covers plain text responses, hosted tools that opt out of hooks, or every possible Claude Code capability. It guards tool calls exposed to the `PreToolUse` lifecycle hook.

## Rotate a key

Ask the user to rotate or revoke the old key in Atbash, replace `agentKey` in the local config themselves, verify the derived public key is onboarded to the exact organization, and start a new Claude Code session. Never handle either key value in the conversation.
