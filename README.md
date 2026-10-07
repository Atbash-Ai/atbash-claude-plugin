# Atbash Safety Plugin for Claude Code

Atbash Safety checks Claude Code tool calls through a `PreToolUse` hook. The plugin ships a prebuilt runtime that bundles `@atbash/sdk` and its native bindings, so users never install the SDK or enter chain settings.

While active, the guard is fail closed. A missing key, invalid configuration, network failure, timeout, `HOLD`, `BLOCK`, or malformed decision prevents the pending tool call. Only a canonical SDK result of `allow: true` with verdict `ALLOW` continues.

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

The Connect Atbash link must be on the service of the installed environment (see the table above). If it is not, the installed build is not the one you expect.

Use the `atbash-manage` skill for later name, purpose, risk, or active-state changes. Each change requires a fresh browser authorization.

## Check status and test

After setup, start a new Claude Code session and review the Atbash hook with `/hooks`. Check the local agent status of the installed plugin with:

```bash
ls ~/.claude/plugins/cache/atbash-ai/atbash/                          # the installed version, for example 0.5.0
node ~/.claude/plugins/cache/atbash-ai/atbash/<version>/runtime/status.cjs
```

Try a harmless request such as reading a file in the workspace. An `ALLOW` decision lets the call run; `HOLD`, `BLOCK`, invalid configuration, and service errors block it.

## Legacy manual configuration

The guided setup is recommended. If you need to configure an existing agent manually, use `~/.config/atbash/config.json` or environment variables in the process that launches Claude Code:

```json
{
  "agentKey": "<your-agent-private-key>",
  "orgName": "<your-exact-organization-name>"
}
```

Never put a private key in a prompt, plugin manifest, committed file, or shell history. The plugin reads the key locally and never uploads the configuration to an MCP service.

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
