# Changelog

All notable changes to this project are documented here.

## Unreleased

- Removed the unused Atbash tool-name bypass. Status and other Atbash-named tools now receive safety judgments and fail closed on configuration errors, closing the red-team N7 namespace exemption.

- Added Claude Code support: a `.claude-plugin/plugin.json` plugin manifest and a repository-root `.claude-plugin/marketplace.json` marketplace catalog, both passing `claude plugin validate --strict`.
- Converted `hooks/hooks.json` to the Claude Code plugin hook format using `${CLAUDE_PLUGIN_ROOT}`.
- Relaxed the `PreToolUse` input contract to match Claude Code's wire format: `model`, `turn_id`, `tool_use_id`, and `transcript_path` are now optional, and `permission_mode` accepts any non-empty string so a new host permission mode cannot deny every tool call.
- Tagged judgment context as `source=claude-code` and included the model only when the host provides it.
- Renamed the hook timeout variable to `ATBASH_HOOK_TIMEOUT_MS`; `ATBASH_CODEX_TIMEOUT_MS` remains a legacy fallback.
- Rewrote the README and the `atbash-setup` skill for the Claude Code install, activation, and deactivation flow.

## 0.3.3 - 2026-08-13

- Added the required square directory logo and composer icon using Atbash's production site icon.
- Shortened the public subtitle to the 30-character directory limit.
- Classified the plugin under the `Security` directory category.
- Added a reviewer-ready submission dossier, legal/support drafts, and explicit release blockers.

## 0.3.2 - 2026-08-12

- Enforced LF text checkouts on every platform so Windows release verification matches the repository's Prettier policy.

## 0.3.1 - 2026-08-12

- Fixed the development bundle's native-loader rewrite on Windows paths.
- Made the packaged-skill verification portable across LF and CRLF checkouts.

## 0.3.0 - 2026-08-12

- Added the bundled `$atbash-setup` skill for secure local setup, activation, status interpretation, troubleshooting, and key-rotation guidance.
- Kept enforcement automatic through the catch-all `PreToolUse` hook; the skill does not decide when Atbash runs.
- Updated the exact npm dependency and universal runtime to `@atbash/sdk@0.6.2`.
- Added release-tag installation instructions and clarified that user private keys remain in local SDK configuration rather than an MCP service.

## 0.2.0 - 2026-08-04

- Updated the exact npm dependency to `@atbash/sdk@0.6.1`.
- Added SDK organization-based chain resolution for Private and Swarm judgment requests.
- Added a Git-backed `atbash-ai` Codex marketplace that installs without cloning, npm install, or a local build.
- Added a committed universal runtime for Apple silicon macOS, glibc Linux x64/arm64, and Windows x64.
- Added runtime provenance, native SHA-256 checksums, cross-platform verification, and universal release artifacts.

## 0.1.0 - 2026-07-22

- Added the activatable `atbash` Codex plugin and repo-local marketplace.
- Added catch-all `PreToolUse` enforcement through exact npm dependency `@atbash/sdk@0.6.0`.
- Added fail-closed handling for configuration, transport, timeout, malformed input, and inconsistent decisions.
- Added `ALLOW`, `HOLD`, `BLOCK`, and `ERROR` mapping with safe user-visible reasons.
- Added the reserved `mcp__atbash__*` recursion bypass.
- Added a self-contained platform build with the npm-selected native SDK binding.
- Added agent status diagnostics, automated tests, CI, protocol evidence, and security documentation.
