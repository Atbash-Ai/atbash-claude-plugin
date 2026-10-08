# Atbash Safety Plugin for Claude Code

Atbash Safety checks Claude Code tool calls through a `PreToolUse` hook. The plugin ships a prebuilt runtime that bundles `@atbash/sdk` and its native bindings, so users never install the SDK or enter chain settings.

While active, the guard is fail closed. A missing key, invalid configuration, network failure, timeout, `HOLD`, `BLOCK`, or malformed decision prevents the pending tool call. Only a canonical SDK result of `allow: true` with verdict `ALLOW` continues.

While active, the guard is fail closed. A missing key, invalid configuration, network failure, timeout, `HOLD`, `BLOCK`, or malformed decision prevents the pending tool call. Only a judge answer of verdict `ALLOW` with an `allow` action (or the audit tier's explicit no-enforcement marker) continues.

## Requirements

- Claude Code 1.0.33 or newer
- Node.js 22.13.0 or newer
- macOS arm64, Linux x64/arm64 (glibc), or Windows x64

## Environments and releases

The plugin exists in two environments. They share the same source code; only the committed runtime in `plugins/atbash/runtime/` differs.

|                 | Production                         | Development                                                           |
| --------------- | ---------------------------------- | --------------------------------------------------------------------- |
| Branch          | `main`                             | `dev`                                                                 |
| Who installs it | Users                              | The team, for testing                                                 |
| Bundled SDK     | `@atbash/sdk` (stable npm release) | `@atbash/sdk-dev` (npm alias of an `@atbash/sdk` dev build)           |
| Atbash service  | `https://atbash.ai`                | `https://chromia-verified-ai-dev-two.vercel.app`                      |
| Chains          | The SDK's production defaults      | Development chains pinned in `plugins/atbash/build-environments.json` |
| Build command   | `npm run build:marketplace`        | `npm run build:marketplace:dev`                                       |

Claude Code installs a plugin straight from the Git branch and runs the committed `runtime/` as-is; there is no install-time build. So **the branch you install from decides the environment.** `plugins/atbash/runtime/manifest.json` records which one a runtime was built for (`"environment": "prod"` or `"dev"`).

How the build picks an environment:

- `plugins/atbash/build-environments.json` is the single source of truth. `prod` uses the stable SDK with no overrides. `dev` uses the development SDK and pins its service endpoint and chains.
- `ATBASH_BUILD_ENV=dev` or `--env dev` selects development; anything unset defaults to `prod`. An unknown name stops the build. The variable is read only at build time; setting it on a user's machine does nothing.
- Only the selected SDK is bundled, so production installs never contain development code or settings.
- The setup helper pairs with the same service the bundled SDK uses, so no extra settings are needed in either environment. Do not set `ATBASH_CONTROL_ORIGIN` for normal use.

## Install (production)

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

## Install for testing (development)

Point the marketplace at the `dev` branch:

```bash
claude plugin marketplace add Atbash-Ai/atbash-claude-plugin#dev
claude plugin install atbash@atbash-ai
```

If your Claude Code version does not accept a branch in the source, clone the branch and add the checkout instead:

```bash
git clone --branch dev --depth 1 https://github.com/Atbash-Ai/atbash-claude-plugin.git ~/atbash-claude-plugin-dev
claude plugin marketplace add ~/atbash-claude-plugin-dev
claude plugin install atbash@atbash-ai
```

Check which environment is installed:

```bash
grep '"environment"' ~/.claude/plugins/cache/atbash-ai/atbash/*/runtime/manifest.json
```

### Switching between production and development

An agent exists only in the environment it was created in: an agent onboarded on development is not registered on production, and the hook fails closed. When you switch, start from a clean install and keep each environment's local profile separate:

```bash
claude plugin uninstall atbash@atbash-ai
claude plugin marketplace remove atbash-ai
rm -rf ~/.claude/plugins/cache/atbash-ai          # both builds share a version number; drop the cached copy
mv ~/.config/atbash ~/.config/atbash.<old-env>    # keep the old environment's profile for later
```

Then install the other environment as above and run setup again. To go back, move the saved folder back to `~/.config/atbash`.

## Set up an agent

Invoke the `atbash-setup` skill and ask Claude Code to start setup. The skill starts a short-lived onboarding session and provides a Connect Atbash link. Sign in and verify your wallet in the browser, then review and approve the exact account, organization, plan, and agent changes. The helper finishes setup and saves the agent key locally under `~/.config/atbash/` with restricted permissions. For an existing agent, it opens a local form for the key; the key is not sent to the dashboard or chat.

Setup works with the plugin enabled. Until an agent is configured, the hook allows only the Atbash setup steps (the setup skill, its helper commands, and the plan file it writes under `~/.config/atbash/plans/`) and denies every other tool call. Once setup activates a profile, every tool call is judged again; `setup continue` reports the new agent's status itself, so no extra judged call is needed. An existing but invalid configuration stays fail closed.

The Connect Atbash link must be on the service of the installed environment (see the table above). If it is not, the installed build is not the one you expect.

Use the `atbash-manage` skill for later name, purpose, risk, or active-state changes. Each change requires a fresh browser authorization.

## Check status and test

After setup, start a new Claude Code session and review the Atbash hook with `/hooks`. Check the local agent status of the installed plugin with:

```bash
ls ~/.claude/plugins/cache/atbash-ai/atbash/                          # the installed version, for example 0.5.0
node ~/.claude/plugins/cache/atbash-ai/atbash/<version>/runtime/status.cjs
```

Try a harmless request such as reading a file in the workspace. An `ALLOW` decision lets the call run; `HOLD`, `BLOCK`, invalid configuration, and service errors block it.

You can deactivate Atbash from the `/plugin` menu or with `claude plugin disable atbash` in your own terminal. Disabling or uninstalling the plugin stops enforcement for subsequent tool calls. The agent cannot do this for you: the hook denies an agent's tool call that would disable Atbash (see [Self-protection](#self-protection)).

## Legacy manual configuration

The guided setup is recommended. If you need to configure an existing agent manually, use `~/.config/atbash/config.json` or environment variables in the process that launches Claude Code:

```json
{
  "agentKey": "<your-agent-private-key>",
  "orgName": "<your-exact-organization-name>"
}
```

Never put a private key in a prompt, plugin manifest, committed file, or shell history. The plugin reads the key locally and never uploads the configuration to an MCP service.

The hook reads these settings:

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

**Judge endpoint rule.** The SDK accepts a plain-http loopback judge with no response signature, and any https judge once a verify key is set - and both settings may come from `~/.config/atbash/config.json`, a file an agent can write. So a planted `judgeEndpoint` (a local server, or someone's own https judge with their own key) could answer `ALLOW` to every call. The hook accepts Atbash's own judge (`https://atbash.ai`, `https://www.atbash.ai`) from anywhere; any other endpoint - local, plain-http, or a self-hosted https judge - is refused, with every call denied and a message naming the fix, unless the hook's own **environment** sets all three: `ATBASH_ENDPOINT` to that judge (a value from the config file is never enough), `ATBASH_JUDGE_VERIFY_PUBKEY` to its 66-hex response-signing key (so the SDK verifies the signature on every verdict), and `ATBASH_DEV_ALLOW_LOCAL_JUDGE=1`. `node plugins/atbash/runtime/status.cjs` reports the same refusal as a `configuration_error`. A permit also needs the judge's own `allow: true`: an answer of `verdict: ALLOW` with `allow: false` is denied (the SDK's `auditToolCall` would otherwise map it to a permit).

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
| Hook stopped by `SIGTERM`/`SIGINT`/`SIGHUP` | Blocks this attempt                                               |
| Hook killed with `SIGKILL`                  | Not blocked: the host proceeds (see the host boundary below)      |

For `HOLD`, operator review remains in Atbash. The plugin does not auto-poll or auto-execute an approved action; retry the original request explicitly after approval.

## Coverage and limits

The hook covers shell execution, file edits and writes, MCP calls, and the other tools that Claude Code exposes to `PreToolUse`. No tool name is exempt from judgment, including Atbash-named diagnostic tools. Direct SDK calls inside the hook do not trigger another host tool call and cannot recurse through this hook.

### The host boundary

Claude Code treats a hook that times out, or exits with any code other than 0 or 2, as a non-blocking error and lets the tool call proceed. Two failures that would silently remove the gate are therefore handled by the entry point itself (`runtime/pre-tool-use.cjs`, a small un-bundled shim that loads the bundled hook `runtime/pre-tool-use-main.cjs`):

- **Hard deadline.** The SDK budget (`ATBASH_HOOK_TIMEOUT_MS`) applies per request, and one judgment is several requests, so a slow but alive judge could outlive the 35 s hook timeout in `hooks/hooks.json`. The shim denies the call at `ATBASH_HOOK_DEADLINE_MS` (default 28,000 ms; accepted range 1,000-30,000, so that node start-up and the bundle load always fit under the host timeout) unless the bundled hook has already written its decision. An invalid value denies every call rather than running without a deadline.
- **Runtime failure.** A bundled hook that cannot load, throws asynchronously, or leaves a promise rejected exits with a deny (exit code 0) instead of exit code 1 and no output. The deny text is fixed; nothing from the failure is echoed to the host.
- **Stopped by a signal.** A hook ended by `SIGTERM`, `SIGINT` or `SIGHUP` before it decided writes the same fixed deny and exits 0 (under node's default action it would end with no output, which the host treats as non-blocking). `SIGKILL` cannot be caught: a hook killed that way ends with no output and the host lets the tool call proceed. Only the host can close that case.
- **Only the decision reaches standard output.** The bundled hook also carries library loggers whose sink is `console.log`; the shim diverts every standard-output chunk that is not a decision (a chunk that parses as JSON with a `hookSpecificOutput.permissionDecision` string; a log line that merely quotes one does not count) to standard error (the host transcript), so a stray log line can neither corrupt the decision nor count as one. Library diagnostics therefore appear in the transcript rather than on the decision channel; a closed standard error drops them. A bundle that wrote its decision but is still alive is ended once those bytes have drained.
- **What the shim cannot close.** The deny is written synchronously, and if standard output cannot be written at all the shim exits with code 2 (a blocking error for the host) rather than 0 with an empty, permit-shaped output. A synchronous hang inside the bundle or the native SDK addon keeps the event loop from running the deadline timer at all; only the host timeout ends that, and that case is fail open at the host. A write straight to file descriptor 1 (not through `process.stdout`) is not intercepted; the JavaScript bundle has none, and the native SDK addon is assumed not to print to it. On POSIX a momentarily full pipe can make the synchronous deny write fail with `EAGAIN`; it is retried while bytes keep being accepted, for at most two seconds without one and never past two seconds after the configured deadline - and in no case past 32 s, two seconds after the largest accepted deadline (every write is tried once whatever the clock says, so a bundle that stalled the event loop past the give-up but under the host's timeout still puts its deny on a healthy standard output, and a first attempt that came that late keeps up to two seconds of retries of its own, bounded by that 32 s ceiling; a transport that dribbles the deny a byte at a time is not a stall and gets the whole deny; a write that reports zero bytes accepted is waited out like a refusal, and one that reports a count that is not a number, negative, or larger than what was offered is an error, never progress), then takes the exit-2 path: still a blocking error, delivered on standard error instead of as JSON.

### Self-protection

The judge is a language model, so a tricked agent asking to switch Atbash off would otherwise be stopped only if the model recognised the request. Before the judge is asked anything, the hook runs a local, deterministic check (`src/hook/self-protection.ts`) and denies - with a reason telling you to make the change yourself, outside the agent - any tool call that would:

- disable, uninstall or remove the Atbash plugin or its marketplace (`claude plugin disable|uninstall|remove atbash…`, `claude plugin disable --all`), switch hooks off (`disableAllHooks`, `codex features disable codex_hooks`, `codex_hooks=false`), or change settings through `claude config set|add|remove`;
- set, unset or remove the variables Atbash reads (`ATBASH_AGENT_KEY`, `ATBASH_ORG_NAME`, `ATBASH_ENDPOINT`, `ATBASH_JUDGE_VERIFY_PUBKEY`, `ATBASH_DEFAULT_CHAIN_NETWORK`, `ATBASH_DEV_ALLOW_LOCAL_JUDGE`, `ATBASH_HOOK_TIMEOUT_MS`, `ATBASH_HOOK_DEADLINE_MS`) or point a nested host elsewhere (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) - in any spelling: `export`, a prefix, `unset`, `env -u`, `setx`, fish `set -x`, `$env:…`, `Remove-Item Env:…`, `[Environment]::SetEnvironmentVariable`, the registry copy (`reg add HKCUEnvironment`, `Set-ItemProperty HKCU:Environment`), Python `os.environ[…]` / `env={…}` and Node `process.env.…`;
- start a nested agent (`claude`, `codex`, `cursor-agent`) with a changed `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `APPDATA`, `NODE_OPTIONS`, `PATH`, `NODE_TLS_*`, `NODE_EXTRA_CA_CERTS` or `SSL_CERT_*`, or with `--settings` / `--setting-sources` - each would let it load other settings, other hooks, or trust another judge;
- write, edit, patch, move or delete `~/.claude/settings.json` / `settings.local.json`, any `.claude/settings*.json`, any `.claude/plugins/`, managed settings, `~/.config/atbash/` (the key and config file), the Codex and Cursor hook, plugin and config files at any level, this plugin's own `runtime/`, `hooks/` and manifest, or the system hosts file (which could re-point the judge's hostname) - including a directory that contains one of them.

It sees through the obvious disguises: quotes and escapes inside words (`cl""aude`, `claude`, `$'claude'`, PowerShell backticks, cmd carets), upper case, `bash -c` / `sh -c` / `eval` wrappers, base64 payloads (piped to a shell or decoded in place, nested twice), reversed text piped through `rev`, PowerShell `-EncodedCommand`, globs, brackets and brace lists (`~/.cl?ude/…`, `~/.c[l]aude/…`, `~/.{claude,x}/…`), `~` / `$HOME` / `%USERPROFILE%` spellings, Git Bash and WSL drive paths, Windows `\?` and `\.` prefixes, NTFS stream suffixes (`settings.json::$DATA` writes the file itself), trailing dots and spaces, `file://` URIs, a path built from separate string arguments (`path.join(home, '.claude', 'settings.json')`), and symlinks or junctions to a protected directory. Reading these files stays allowed: a shell command that names one is denied only when some part of it is not a known read-only command, and the options that make a reader write or execute count as writes (`sed` with anything but `-n` and a line-range print, `find -exec/-delete`, `git -c`, `git --ext-diff/--textconv/--output` anywhere on the line, `rg --pre`, `tree -o`, an environment prefix, a PowerShell script block, a command substitution; `sort`, `uniq` and `git grep` are not treated as readers at all). An input the check cannot read in full - a command over 256 KiB, more than 4,096 path tokens or symlink lookups, nesting deeper than 32 levels - is denied, never passed unread. Other `ATBASH_*` names (for example test-harness settings) are not matched.

One exception keeps guided setup and agent management working: the onboarding plan step. A `Write` of exactly `~/.config/atbash/plans/<job-id>.json` (a regular file, not a symlink, in a plans directory that is not a symlink) and the exact helper command `node <plugin>/skills/atbash-setup|atbash-manage/scripts/atbash-control.mjs setup|manage plan <job-id> --input <that file>` skip this check; nothing else under `~/.config/atbash/` does. A plan is a non-secret proposal the user still signs in the browser, and the call is still judged like any other.

What it cannot see is indirection its text does not show - a script written earlier and run later, a path assembled by string concatenation, a repository hook - and anything the host does not route through `PreToolUse`; those stay with the judge. It is a floor under the judge, not a replacement for it. The check was run over 10,000+ real tool calls from this project's own agent transcripts to keep false positives down; the cases are pinned in `tests/self-protection.test.ts`, `tests/self-protection-bypasses.test.ts` and `tests/self-protection-host.test.ts`.

Tools that opt out of hooks are outside hook coverage, and plain model responses have no tool call to judge. Consequently, this plugin is a strong lifecycle guardrail, not a complete host security boundary.

The plugin sends the tool name, raw tool argument object, and minimal context (source, workspace basename, permission mode, and model when provided) to `auditToolCall()`. The SDK performs its built-in secret redaction before judgment. The plugin does not read or send the transcript.

## Development

```bash
npm ci
npm run verify                  # typecheck, lint, tests, build, formatting
npm run build:marketplace:dev   # regenerate runtime/ for dev
npm run build:marketplace       # regenerate runtime/ for main
```

Commit the regenerated `plugins/atbash/runtime/` whenever source or SDK versions change: a development build on `dev`, a production build on `main`.

### Release: `dev` → `main`

`main` must always carry a production runtime. Merge through a short-lived release branch that rebuilds for production:

```bash
git switch dev && git pull
git switch -c release/<yyyy-mm-dd>
npm ci
npm run build:marketplace        # rebuild runtime/ for production
npm run verify
git add plugins/atbash/runtime
git commit -m "build: production runtime"
git push -u origin release/<yyyy-mm-dd>
```

Open the pull request into `main` only. Never merge the release branch back into `dev`.

If `main` is ever merged into `dev` (for example a hotfix), rebuild with `npm run build:marketplace:dev` on `dev` and commit `runtime/` again.

### Updating SDK versions

```bash
# Production SDK (main)
npm install --save-exact @atbash/sdk@<version> --workspace @atbash/claude-plugin

# Development SDK (dev)
npm install --save-exact --save-dev @atbash/sdk-dev@npm:@atbash/sdk@<dev-version> --workspace @atbash/claude-plugin
```

Then rebuild the runtime for the branch you are on and commit it. Keep the development SDK on the same version the Atbash dashboard's `development` branch uses. The development service endpoint and chain node pools live in `plugins/atbash/build-environments.json`.

### CI checks

- `.github/workflows/ci.yml` (every push and pull request): runs `npm run verify`, rebuilds `runtime/` for the environment recorded in `runtime/manifest.json`, and fails if the committed runtime differs. Pushes to `main` and pull requests into `main` also fail unless the runtime is a production build.
- `.github/workflows/release.yml` (`v*` tags): requires a production runtime, verifies on macOS, Linux, and Windows, and packages the plugin.

`node plugins/atbash/runtime-environment.mjs` prints the environment of the committed runtime; add `--require prod` to fail on anything else.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) for development and security information.
