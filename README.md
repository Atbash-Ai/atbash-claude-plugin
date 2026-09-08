# Atbash Safety Plugin

Atbash Safety is a Claude Code plugin that evaluates supported tool calls through `@atbash/sdk@0.6.2` before Claude Code executes them. It uses a catch-all `PreToolUse` hook, so enforcement is mechanical: the model does not decide when to call Atbash. A bundled `atbash-setup` skill guides secure local configuration and diagnostics without moving user keys to an MCP server.

While active, the guard is fail closed. A missing key, invalid configuration, network failure, timeout, `HOLD`, `BLOCK`, or malformed decision prevents the pending tool call. Only a canonical SDK result of `allow: true` with verdict `ALLOW` continues.

The repository also carries the manifests for the original Codex distribution (`.codex-plugin/`, `.agents/plugins/marketplace.json`); the active hook definition on this branch targets Claude Code.

## Requirements

- A supported 64-bit platform: Apple silicon macOS, glibc Linux on x64/arm64, or Windows x64
- Node.js 22.13.0 or newer on `PATH` for the hook process
- A configured and onboarded Atbash agent
- A Claude Code version with plugin support (1.0.33 or newer)

## Install from the Git marketplace

No clone, npm install, or local build is required. The plugin ships a committed universal runtime with native bindings for every supported platform. Add this repository as a marketplace, then install Atbash from it.

From the terminal:

```bash
claude plugin marketplace add Atbash-Ai/atbash_chatgpt_plugin
claude plugin install atbash@atbash-ai
```

Or inside a Claude Code session:

```text
/plugin marketplace add Atbash-Ai/atbash_chatgpt_plugin
/plugin install atbash@atbash-ai
```

Configure Atbash locally before enabling the plugin. The guard intentionally fails closed when configuration is missing, so an unconfigured install denies tool calls instead of silently allowing them.

To fetch a newer marketplace revision and update the installed plugin:

```bash
claude plugin marketplace update atbash-ai
claude plugin update atbash@atbash-ai
```

## Configure Atbash

The plugin calls `Atbash.fromConfig()`. The SDK resolves values in this order: explicit SDK option, environment variable, then `~/.config/atbash/config.json`.

| Setting           | Environment variable     | Required                                   |
| ----------------- | ------------------------ | ------------------------------------------ |
| Agent private key | `ATBASH_AGENT_KEY`       | Yes, unless present in the SDK config file |
| Organization      | `ATBASH_ORG_NAME`        | Yes; must match the agent's onboarded org  |
| Judge endpoint    | `ATBASH_ENDPOINT`        | No                                         |
| Blockchain RID    | `ATBASH_BLOCKCHAIN_RID`  | No                                         |
| Provider          | `ATBASH_PROVIDER`        | No                                         |
| Provider model    | `ATBASH_PROVIDER_MODEL`  | No                                         |
| Hook SDK timeout  | `ATBASH_HOOK_TIMEOUT_MS` | No; defaults to 30,000 ms                  |

`ATBASH_CODEX_TIMEOUT_MS` is still honored as a legacy fallback for the hook timeout.

Only the private key is configured. The SDK validates it, uses it locally for agent identity and cryptographic signing, and derives the corresponding public key locally. The public key must already be onboarded to the named organization in the [Atbash agent dashboard](https://atbash.ai/risk-engine/agents), but it should not be added to the plugin configuration. The plugin never uploads the config file or private key to an MCP service.

### Persistent configuration

This is the recommended setup because hook processes can read it regardless of how Claude Code was launched. Create `~/.config/atbash/config.json` on macOS/Linux, or `%USERPROFILE%\.config\atbash\config.json` on Windows:

```json
{
  "agentKey": "<your-agent-private-key>",
  "orgName": "<your-exact-organization-name>"
}
```

On macOS/Linux, create the directory and restrict access to the file:

```bash
mkdir -p ~/.config/atbash
chmod 700 ~/.config/atbash
$EDITOR ~/.config/atbash/config.json
chmod 600 ~/.config/atbash/config.json
```

On Windows PowerShell, create the directory and open the file in Notepad:

```powershell
New-Item -ItemType Directory -Force "$HOME\.config\atbash"
notepad "$HOME\.config\atbash\config.json"
```

Keep the Windows file readable only by your account using the normal file Security settings or your organization's secret-management tooling.

### Environment variables for one session

Alternatively, set the values in the terminal that launches Claude Code:

```bash
read -s ATBASH_AGENT_KEY
export ATBASH_AGENT_KEY
export ATBASH_ORG_NAME="<your-exact-organization-name>"
claude
```

PowerShell equivalent:

```powershell
$secureKey = Read-Host "Atbash private key" -AsSecureString
$env:ATBASH_AGENT_KEY = [System.Net.NetworkCredential]::new("", $secureKey).Password
$env:ATBASH_ORG_NAME = "<your-exact-organization-name>"
claude
```

Environment changes do not reach an already-running desktop app. Restart Claude Code or use the persistent config file, then start a new session.

Never put the private key in a prompt, tool argument, plugin manifest, committed file, or shell history. `.env.example` lists supported variable names, but the plugin does not load dotenv files itself.

The plugin explicitly resolves and forwards the organization name to the SDK. This is required for Private and Swarm organizations because the org determines which Chromia chain signs and evaluates each action.

Check the configured agent from a source checkout of the repository:

```bash
npm run status --workspace @atbash/codex-plugin
```

The command reports `ready`, `configuration_error`, `agent_not_registered`, `agent_jailed`, or `service_error`. It never prints the private key.

## Activate and verify

After installation and configuration, start a new Claude Code session. The plugin's `PreToolUse` hook loads automatically while the plugin is enabled; review it any time with `/hooks`.

Invoke the `atbash-setup` skill whenever you want guided setup, status interpretation, key-rotation guidance, or an explanation of Atbash verdicts. The skill never decides whether a tool call should be judged; the hook automatically checks every supported call while active.

Test activation with a harmless request such as "Run `pwd`, then list the files in the current repository." An ordinary allowed action should execute after an Atbash `ALLOW` decision. Do not use destructive or privileged commands as activation tests.

You can deactivate Atbash from the `/plugin` menu or with `claude plugin disable atbash`. Disabling or uninstalling the plugin stops enforcement for subsequent tool calls.

## Decision behavior

| Atbash result                               | Claude Code behavior                                              |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `ALLOW` with `allow: true`                  | Executes the pending call                                         |
| `HOLD`                                      | Blocks this attempt and shows its Atbash reference when available |
| `BLOCK`                                     | Blocks this attempt                                               |
| `ERROR` or inconsistent output              | Blocks this attempt                                               |
| Missing/invalid configuration or hook input | Blocks this attempt                                               |

For `HOLD`, operator review remains in Atbash. The plugin does not auto-poll or auto-execute an approved action; retry the original request explicitly after approval.

## Coverage and limits

The hook covers shell execution, file edits and writes, MCP calls, and the other tools that Claude Code exposes to `PreToolUse`. No tool name is exempt from judgment, including Atbash-named diagnostic tools. Direct SDK calls inside the hook do not trigger another host tool call and cannot recurse through this hook.

Tools that opt out of hooks are outside hook coverage, and plain model responses have no tool call to judge. Consequently, this plugin is a strong lifecycle guardrail, not a complete host security boundary.

The plugin sends the tool name, raw tool argument object, and minimal context (source, workspace basename, permission mode, and model when provided) to `auditToolCall()`. The SDK performs its built-in secret redaction before judgment. The plugin does not read or send the transcript.

## Development

```bash
npm install
npm run verify
npm run build:marketplace
```

`verify` runs type checking, linting, automated tests, a platform-specific development build, and formatting checks. `build:marketplace` regenerates the committed universal runtime from the exact npm SDK version and downloads its four supported native packages. The installed plugin does not run npm lifecycle scripts or require npm; it uses this committed runtime. The build does not reimplement Atbash signing, redaction, normalization, or policy logic.

Validate the plugin and marketplace manifests with the Claude Code CLI:

```bash
claude plugin validate ./plugins/atbash --strict
claude plugin validate . --strict
```

Repository layout:

- `.claude-plugin/marketplace.json` — Git-backed Claude Code marketplace catalog
- `plugins/atbash/.claude-plugin/plugin.json` — Claude Code plugin manifest
- `plugins/atbash/` — automatic hook, setup skill, SDK adapter, diagnostics, tests, and committed universal runtime
- `.codex-plugin/`, `.agents/plugins/marketplace.json` — manifests for the Codex distribution
- `docs/v1-architecture-contract.md` — accepted behavior and boundaries
- `docs/hook-protocol-verification.md` — verified hook wire contract

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development rules and [SECURITY.md](./SECURITY.md) for vulnerability reporting.
