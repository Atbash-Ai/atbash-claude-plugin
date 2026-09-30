# Atbash Safety Plugin

Atbash Safety is a Claude Code plugin that evaluates supported tool calls through `@atbash/sdk@0.9.1` before Claude Code executes them. It uses a catch-all `PreToolUse` hook, so enforcement is mechanical: the model does not decide when to call Atbash. A bundled `atbash-setup` skill guides secure local configuration and diagnostics without moving user keys to an MCP server.

While active, the guard is fail closed. A missing key, invalid configuration, network failure, timeout, `HOLD`, `BLOCK`, or malformed decision prevents the pending tool call. Only a canonical SDK result of `allow: true` with verdict `ALLOW` continues.

## Requirements

- A supported 64-bit platform: Apple silicon macOS, glibc Linux on x64/arm64, or Windows x64
- Node.js 22.13.0 or newer on `PATH` for the hook process
- A configured and onboarded Atbash agent
- A Claude Code version with plugin support (1.0.33 or newer)

## Install from the Git marketplace

No clone, npm install, or local build is required. The plugin ships a committed universal runtime with native bindings for every supported platform. Add this repository as a marketplace, then install Atbash from it.

From the terminal:

```bash
claude plugin marketplace add Atbash-Ai/atbash-claude-plugin
claude plugin install atbash@atbash-ai
```

Or inside a Claude Code session:

```text
/plugin marketplace add Atbash-Ai/atbash-claude-plugin
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

| Setting                    | Environment variable           | Required                                                                                         |
| -------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| Agent private key          | `ATBASH_AGENT_KEY`             | Yes, unless present in the SDK config file                                                       |
| Organization               | `ATBASH_ORG_NAME`              | Yes; must match the agent's onboarded org                                                        |
| Judge endpoint             | `ATBASH_ENDPOINT`              | No; any judge other than Atbash's own needs the two settings below, all three in the environment |
| Judge response-signing key | `ATBASH_JUDGE_VERIFY_PUBKEY`   | For a local or self-hosted judge; environment only, 66 hex digits                                |
| Other judge (developers)   | `ATBASH_DEV_ALLOW_LOCAL_JUDGE` | No; `1` allows a local or self-hosted judge; environment only                                    |
| Chain migration switch     | `ATBASH_DEFAULT_CHAIN_NETWORK` | No; leave unset                                                                                  |
| Hook SDK timeout           | `ATBASH_HOOK_TIMEOUT_MS`       | No; defaults to 30,000 ms                                                                        |
| Hook hard deadline         | `ATBASH_HOOK_DEADLINE_MS`      | No; defaults to 28,000 ms (1,000-30,000)                                                         |

SDK 0.9.1 no longer reads `ATBASH_BLOCKCHAIN_RID`, `ATBASH_PROVIDER` or `ATBASH_PROVIDER_MODEL`; the chain follows the organization.

**Judge endpoint rule.** The SDK accepts a plain-http loopback judge with no response signature, and any https judge once a verify key is set - and both settings may come from `~/.config/atbash/config.json`, a file an agent can write. So a planted `judgeEndpoint` (a local server, or someone's own https judge with their own key) could answer `ALLOW` to every call. The hook accepts Atbash's own judge (`https://atbash.ai`, `https://www.atbash.ai`) from anywhere; any other endpoint - local, plain-http, or a self-hosted https judge - is refused, with every call denied and a message naming the fix, unless the hook's own **environment** sets all three: `ATBASH_ENDPOINT` to that judge (a value from the config file is never enough), `ATBASH_JUDGE_VERIFY_PUBKEY` to its 66-hex response-signing key (so the SDK verifies the signature on every verdict), and `ATBASH_DEV_ALLOW_LOCAL_JUDGE=1`. `node plugins/atbash/runtime/status.cjs` reports the same refusal as a `configuration_error`. A permit also needs the judge's own `allow: true`: an answer of `verdict: ALLOW` with `allow: false` is denied (SDK 0.9.1's `auditToolCall` would otherwise map it to a permit).

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
npm run status --workspace @atbash/claude-plugin
```

The command reports `ready`, `configuration_error`, `agent_not_registered`, `agent_jailed`, or `service_error`. It never prints the private key.

## Activate and verify

After installation and configuration, start a new Claude Code session. The plugin's `PreToolUse` hook loads automatically while the plugin is enabled; review it any time with `/hooks`.

Invoke the `atbash-setup` skill whenever you want guided setup, status interpretation, key-rotation guidance, or an explanation of Atbash verdicts. The skill never decides whether a tool call should be judged; the hook automatically checks every supported call while active.

Test activation with a harmless request such as "Run `pwd`, then list the files in the current repository." An ordinary allowed action should execute after an Atbash `ALLOW` decision. Do not use destructive or privileged commands as activation tests.

You can deactivate Atbash from the `/plugin` menu or with `claude plugin disable atbash` in your own terminal. Disabling or uninstalling the plugin stops enforcement for subsequent tool calls. The agent cannot do this for you: the hook denies an agent's tool call that would disable Atbash (see [Self-protection](#self-protection)).

## Decision behavior

| Atbash result                               | Claude Code behavior                                              |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `ALLOW` with `allow: true`                  | Executes the pending call                                         |
| `HOLD`                                      | Blocks this attempt and shows its Atbash reference when available |
| `BLOCK`                                     | Blocks this attempt                                               |
| `ERROR` or inconsistent output              | Blocks this attempt                                               |
| Missing/invalid configuration or hook input | Blocks this attempt                                               |
| Judge still pending at the hard deadline    | Blocks this attempt                                               |
| Hook runtime cannot load or crashes         | Blocks this attempt                                               |

For `HOLD`, operator review remains in Atbash. The plugin does not auto-poll or auto-execute an approved action; retry the original request explicitly after approval.

## Coverage and limits

The hook covers shell execution, file edits and writes, MCP calls, and the other tools that Claude Code exposes to `PreToolUse`. No tool name is exempt from judgment, including Atbash-named diagnostic tools. Direct SDK calls inside the hook do not trigger another host tool call and cannot recurse through this hook.

### The host boundary

Claude Code treats a hook that times out, or exits with any code other than 0 or 2, as a non-blocking error and lets the tool call proceed. Two failures that would silently remove the gate are therefore handled by the entry point itself (`runtime/pre-tool-use.cjs`, a small un-bundled shim that loads the bundled hook `runtime/pre-tool-use-main.cjs`):

- **Hard deadline.** The SDK budget (`ATBASH_HOOK_TIMEOUT_MS`) applies per request, and one judgment is several requests, so a slow but alive judge could outlive the 35 s hook timeout in `hooks/hooks.json`. The shim denies the call at `ATBASH_HOOK_DEADLINE_MS` (default 28,000 ms; accepted range 1,000-30,000, so that node start-up and the bundle load always fit under the host timeout) unless the bundled hook has already written its decision. An invalid value denies every call rather than running without a deadline.
- **Runtime failure.** A bundled hook that cannot load, throws asynchronously, or leaves a promise rejected exits with a deny (exit code 0) instead of exit code 1 and no output. The deny text is fixed; nothing from the failure is echoed to the host.
- **Only the decision reaches standard output.** The bundled hook also carries library loggers whose sink is `console.log`; the shim diverts every standard-output chunk that is not a decision (a chunk that parses as JSON with a `hookSpecificOutput.permissionDecision` string; a log line that merely quotes one does not count) to standard error (the host transcript), so a stray log line can neither corrupt the decision nor count as one. Library diagnostics therefore appear in the transcript rather than on the decision channel; a closed standard error drops them. A bundle that wrote its decision but is still alive is ended once those bytes have drained.
- **What the shim cannot close.** The deny is written synchronously, and if standard output cannot be written at all the shim exits with code 2 (a blocking error for the host) rather than 0 with an empty, permit-shaped output. A synchronous hang inside the bundle or the native SDK addon keeps the event loop from running the deadline timer at all; only the host timeout ends that, and that case is fail open at the host. A write straight to file descriptor 1 (not through `process.stdout`) is not intercepted; the JavaScript bundle has none, and the native SDK addon is assumed not to print to it. On POSIX a momentarily full pipe can make the synchronous deny write fail with `EAGAIN`; it is retried while bytes keep being accepted, for at most two seconds without one and never past two seconds after the configured deadline - and in no case past 32 s, two seconds after the largest accepted deadline (every write is tried once whatever the clock says, so a bundle that stalled the event loop past the give-up but under the host's timeout still puts its deny on a healthy standard output, and a first attempt that came that late keeps up to two seconds of retries of its own, bounded by that 32 s ceiling; a transport that dribbles the deny a byte at a time is not a stall and gets the whole deny; a write that reports zero bytes accepted is waited out like a refusal, and one that reports a count that is not a number, negative, or larger than what was offered is an error, never progress), then takes the exit-2 path: still a blocking error, delivered on standard error instead of as JSON.

### Self-protection

The judge is a language model, so a tricked agent asking to switch Atbash off would otherwise be stopped only if the model recognised the request. Before the judge is asked anything, the hook runs a local, deterministic check (`src/hook/self-protection.ts`) and denies - with a reason telling you to make the change yourself, outside the agent - any tool call that would:

- disable, uninstall or remove the Atbash plugin or its marketplace (`claude plugin disable|uninstall|remove atbash…`, `claude plugin disable --all`), switch hooks off (`disableAllHooks`, `codex features disable codex_hooks`, `codex_hooks=false`), or change settings through `claude config set|add|remove`;
- set, unset or remove the variables Atbash reads (`ATBASH_AGENT_KEY`, `ATBASH_ORG_NAME`, `ATBASH_ENDPOINT`, `ATBASH_JUDGE_VERIFY_PUBKEY`, `ATBASH_DEFAULT_CHAIN_NETWORK`, `ATBASH_DEV_ALLOW_LOCAL_JUDGE`, `ATBASH_HOOK_TIMEOUT_MS`, `ATBASH_HOOK_DEADLINE_MS`) or point a nested host elsewhere (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) - in any spelling: `export`, a prefix, `unset`, `env -u`, `setx`, fish `set -x`, `$env:…`, `Remove-Item Env:…`, `[Environment]::SetEnvironmentVariable`, the registry copy (`reg add HKCUEnvironment`, `Set-ItemProperty HKCU:Environment`), Python `os.environ[…]` / `env={…}` and Node `process.env.…`;
- start a nested agent (`claude`, `codex`, `cursor-agent`) with a changed `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `APPDATA`, `NODE_OPTIONS`, `PATH`, `NODE_TLS_*`, `NODE_EXTRA_CA_CERTS` or `SSL_CERT_*`, or with `--settings` / `--setting-sources` - each would let it load other settings, other hooks, or trust another judge;
- write, edit, patch, move or delete `~/.claude/settings.json` / `settings.local.json`, any `.claude/settings*.json`, any `.claude/plugins/`, managed settings, `~/.config/atbash/` (the key and config file), the Codex and Cursor hook, plugin and config files at any level, this plugin's own `runtime/`, `hooks/` and manifest, or the system hosts file (which could re-point the judge's hostname) - including a directory that contains one of them.

It sees through the obvious disguises: quotes and escapes inside words (`cl""aude`, `claude`, `$'claude'`, PowerShell backticks, cmd carets), upper case, `bash -c` / `sh -c` / `eval` wrappers, base64 payloads (piped to a shell or decoded in place, nested twice), reversed text piped through `rev`, PowerShell `-EncodedCommand`, globs, brackets and brace lists (`~/.cl?ude/…`, `~/.c[l]aude/…`, `~/.{claude,x}/…`), `~` / `$HOME` / `%USERPROFILE%` spellings, Git Bash and WSL drive paths, Windows `\?` and `\.` prefixes, NTFS stream suffixes (`settings.json::$DATA` writes the file itself), trailing dots and spaces, `file://` URIs, a path built from separate string arguments (`path.join(home, '.claude', 'settings.json')`), and symlinks or junctions to a protected directory. Reading these files stays allowed: a shell command that names one is denied only when some part of it is not a known read-only command, and the options that make a reader write or execute count as writes (`sed` with anything but `-n` and a line-range print, `find -exec/-delete`, `git -c`, `git --ext-diff/--textconv/--output` anywhere on the line, `rg --pre`, `tree -o`, an environment prefix, a PowerShell script block, a command substitution; `sort`, `uniq` and `git grep` are not treated as readers at all). An input the check cannot read in full - a command over 256 KiB, more than 4,096 path tokens or symlink lookups, nesting deeper than 32 levels - is denied, never passed unread. Other `ATBASH_*` names (for example test-harness settings) are not matched.

What it cannot see is indirection its text does not show - a script written earlier and run later, a path assembled by string concatenation, a repository hook - and anything the host does not route through `PreToolUse`; those stay with the judge. It is a floor under the judge, not a replacement for it. The check was run over 10,000+ real tool calls from this project's own agent transcripts to keep false positives down; the cases are pinned in `tests/self-protection.test.ts`, `tests/self-protection-bypasses.test.ts` and `tests/self-protection-host.test.ts`.

Tools that opt out of hooks are outside hook coverage, and plain model responses have no tool call to judge. Consequently, this plugin is a strong lifecycle guardrail, not a complete host security boundary.

The plugin sends the tool name, raw tool argument object, and minimal context (source, workspace basename, permission mode, and model when provided) to `auditToolCall()`. The SDK performs its built-in secret redaction before judgment. The plugin does not read or send the transcript.

## Development

```bash
npm install
npm run verify
npm run build:marketplace
```

`verify` runs type checking, linting, automated tests, a platform-specific development build, and formatting checks. `build:marketplace` regenerates the committed universal runtime from the exact npm SDK version and downloads its four supported native packages. The installed plugin does not run npm lifecycle scripts or require npm; it uses this committed runtime. The build does not reimplement Atbash signing, redaction, normalization, or policy logic.

The committed native binaries under `plugins/atbash/runtime/native/` are byte-identical to the published `@atbash/sdk-*` npm packages: `runtime/manifest.json` records each package name and SHA-256, the test suite recomputes the checksums, and CI reruns `npm run build:marketplace` and fails on any diff against the committed runtime.

Validate the plugin and marketplace manifests with the Claude Code CLI:

```bash
claude plugin validate ./plugins/atbash --strict
claude plugin validate . --strict
```

Repository layout:

- `.claude-plugin/marketplace.json` — Git-backed Claude Code marketplace catalog
- `plugins/atbash/.claude-plugin/plugin.json` — Claude Code plugin manifest
- `plugins/atbash/` — automatic hook, setup skill, SDK adapter, diagnostics, tests, and committed universal runtime

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development rules and [SECURITY.md](./SECURITY.md) for vulnerability reporting.
