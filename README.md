# Atbash Codex Plugin

Atbash Safety is an activatable Codex plugin that evaluates supported tool calls through `@atbash/sdk@0.6.1` before Codex executes them. It uses a catch-all `PreToolUse` hook, so enforcement is mechanical: the model does not decide when to call Atbash.

While active, the guard is fail closed. A missing key, invalid configuration, network failure, timeout, `HOLD`, `BLOCK`, or malformed decision prevents the pending tool call. Only a canonical SDK result of `allow: true` with verdict `ALLOW` continues.

## Requirements

- A supported 64-bit platform: Apple silicon macOS, glibc Linux on x64/arm64, or Windows x64
- Node.js 22.13.0 or newer
- npm 10 or newer
- A configured and onboarded Atbash agent
- A Codex build with plugins and lifecycle hooks enabled

## Install from this repository

Build on the same platform where Codex will run. The build embeds the native binary selected by the exact npm SDK dependency so the Codex plugin cache is self-contained.

```bash
git clone https://github.com/Atbash-Ai/atbash_chatgpt_plugin.git
cd atbash_chatgpt_plugin
npm ci
npm run verify
codex plugin marketplace add "$(pwd)"
codex plugin add atbash@personal
```

Start a new Codex task after installation. Open `/hooks`, review the Atbash command, and trust it. Installation does not silently trust executable hooks.

The plugin is active only when it is installed and enabled, lifecycle hooks are enabled, and the current hook definition is trusted. You can deactivate it from Codex's Plugins controls; disabling or untrusting its hook also stops enforcement.

## Configure Atbash

The plugin calls `Atbash.fromConfig()`. The SDK resolves values in this order: explicit SDK option, environment variable, then `~/.config/atbash/config.json`.

| Setting           | Environment variable      | Required                                   |
| ----------------- | ------------------------- | ------------------------------------------ |
| Agent private key | `ATBASH_AGENT_KEY`        | Yes, unless present in the SDK config file |
| Organization      | `ATBASH_ORG_NAME`         | Yes for paid/private-chain organizations   |
| Judge endpoint    | `ATBASH_ENDPOINT`         | No                                         |
| Blockchain RID    | `ATBASH_BLOCKCHAIN_RID`   | No                                         |
| Provider          | `ATBASH_PROVIDER`         | No                                         |
| Provider model    | `ATBASH_PROVIDER_MODEL`   | No                                         |
| Hook SDK timeout  | `ATBASH_CODEX_TIMEOUT_MS` | No; defaults to 30,000 ms                  |

Never put the private key in a prompt, tool argument, plugin manifest, or committed file. `.env.example` lists supported variable names, but the plugin does not load dotenv files itself; Codex must inherit those environment variables, or the values must be in the SDK user config.

The plugin explicitly resolves and forwards the organization name to the SDK. This is required for Private and Swarm organizations because the org determines which Chromia chain signs and evaluates each action.

Check the configured agent from the repository:

```bash
npm run status --workspace @atbash/codex-plugin
```

The command reports `ready`, `configuration_error`, `agent_not_registered`, `agent_jailed`, or `service_error`. It never prints the private key.

## Decision behavior

| Atbash result                               | Codex behavior                                                    |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `ALLOW` with `allow: true`                  | Executes the pending call                                         |
| `HOLD`                                      | Blocks this attempt and shows its Atbash reference when available |
| `BLOCK`                                     | Blocks this attempt                                               |
| `ERROR` or inconsistent output              | Blocks this attempt                                               |
| Missing/invalid configuration or hook input | Blocks this attempt                                               |

For `HOLD`, operator review remains in Atbash. The plugin does not auto-poll or auto-execute an approved action; retry the original request explicitly after approval.

## Coverage and limits

The hook covers shell/unified execution, patches and writes, MCP calls, and other local function tools that Codex exposes to `PreToolUse`. The exact `mcp__atbash__*` namespace is reserved for future Atbash diagnostics and bypasses the guard to prevent recursion.

Hosted tools such as web search and specialized tools that opt out of hooks are outside current Codex hook coverage. Plain model responses have no tool call to judge. Consequently, this plugin is a strong lifecycle guardrail, not a complete host security boundary.

The plugin sends the tool name, raw tool argument object, and minimal context (Codex, workspace basename, model, and permission mode) to `auditToolCall()`. The SDK performs its built-in secret redaction before judgment. The plugin does not read or send the transcript.

## Development

```bash
npm install
npm run verify
```

`verify` runs type checking, linting, a platform-specific distributable build, 22 tests, and formatting checks. The build bundles the npm SDK's JavaScript layer and embeds its npm-selected native binding; it does not reimplement Atbash signing, redaction, normalization, or policy logic.

Repository layout:

- `plugins/atbash/` — plugin manifest, hook, SDK adapter, diagnostics, and tests
- `.agents/plugins/marketplace.json` — repo-local Codex marketplace
- `docs/v1-architecture-contract.md` — accepted behavior and boundaries
- `docs/hook-protocol-verification.md` — verified Codex hook wire contract

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development rules and [SECURITY.md](./SECURITY.md) for vulnerability reporting.
