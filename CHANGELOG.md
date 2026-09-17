# Changelog

All notable changes to this project are documented here.

## Unreleased

- Fixed a fail-open at the host boundary: Claude Code proceeds with the tool call when a hook times out or exits with a code other than 0 or 2. `runtime/pre-tool-use.cjs` is now a small un-bundled shim in front of the bundled hook (`runtime/pre-tool-use-main.cjs`) that denies the call at a hard deadline (`ATBASH_HOOK_DEADLINE_MS`, default 28,000 ms, range 1,000-30,000, counted from process start) when the judge is still pending, denies when the bundled runtime cannot load, throws asynchronously or rejects unhandled, and denies on an invalid deadline value. The deny is written synchronously and never after a decision the bundled hook already wrote; if standard output cannot be written the shim exits 2 (blocking) instead of 0 with empty output. The bundled hook hands its decision to the shim over a private in-process channel (`Symbol.for("atbash.hook.answer")`, installed by the shim before the bundle loads; `deliverDecision` in `src/hook/protocol.ts`), never over standard output: everything the bundle or its libraries write to standard output is diverted to standard error, so no log line, however well shaped, can be taken for the decision. The channel accepts exactly one thing, a PreToolUse deny as `serializeDeny` emits it (never an allow: the bundle's allow is silence, which leaves the host's own rules and other hooks in force); anything else on it is a deny, a stray empty answer neither disarms the deadline nor outranks a later deny, the bundle's deny is written with a callback so a broken stdout ends as a blocking exit rather than a lost decision, and an exit-time backstop turns a bundle that returns without answering (or a library calling `process.exit(0)`) into a deny instead of an empty permit-shaped exit, and a decision that was queued but never drained into a blocking exit rather than a truncated one; the shim re-serializes the bundle's deny itself so no sibling key reaches the host, a host that never reads a queued deny ends the hook with a blocking exit two seconds past the deadline (reported on standard error; capped two seconds past the largest deadline, so never past the host timeout even for a decision queued late), the deny written to the host is bounded at 3.5 KiB of serialized bytes (not characters: JSON escaping doubles a quote or a newline and a non-ASCII character is up to three bytes; the judge's own reason is capped at 800 characters upstream) - under the smallest pipe buffer a host hands a hook (4 KiB for a bare CreatePipe, 64 KiB for a libuv pipe), so the write always completes into the pipe whether or not the host has read yet; a larger deny to a host that never reads blocks the writing thread on Windows and nothing in-process can interrupt that (a blocked event loop runs no watchdog, and a pool thread blocked in `fs.write` is joined by `process.exit`) - measured through a real OS pipe whose consumer never reads, which a node parent with a paused socket does not model (libuv keeps reading ~64 KiB into its own buffer). The deny is written to file descriptor 1 synchronously, so it is out before anything else in the process can run: an asynchronous write was tried and abandoned, because its completion callback never runs when in-process code exits in the same turn, which left a complete deny on standard output behind an exit code of 2 (blocking for Claude Code, a permit on Codex); a deny whose reason is not a string is refused as invalid, anything already on the channel when the shim loads (a function some preloaded module put there through `NODE_OPTIONS=--require`, a second copy of the shim, any value at all) is refused with a canonical deny on standard output and exit 0 - the one answer both hosts block on: Claude Code documents exit 2 as blocking, but Codex 0.154.0 does not block on it (measured on the real host with marker files: exit 2 with a reason on standard error, and even exit 2 with a deny on standard output, let the tool call run; only a deny with exit 0 blocked). Every fail-closed path therefore writes the deny to standard output and exits 0 whenever standard output can take one; exit 2 with the reason on standard error remains only for a standard output that cannot be written at all (blocking for Claude Code, a documented residual on Codex). A marker on the channel function itself records that a decision is on standard output - a preload cannot pre-set it on a channel that does not exist yet, and a load that refuses a taken channel never consults it, so a forged mark on a foreign function cannot silence the refusal - and the first load's exit backstop, channel and deadline honour it, so a refused second load and the first load never produce two decisions; a transport that never accepts the write (retried for about a second) ends with exit 2 and the reason on standard error, nothing on standard output; the deny is on standard output before the exit is attempted, so a `process.exit` patched away in-process changes nothing (in-process code that makes `process.exit` throw ends the hook at node's exit 1, non-blocking for the host, whatever the shim does - the same in-process control as patching the file system, documented as out of scope) - there is no second-load exemption, because nothing in-process can tell the shim's own copy from a decoy that copied it, and before this the shim stepped aside for any function it found there (no deadline, no bundle, no exit backstop: a silent permit); a second load of the shim therefore never adds a second decision (the refused load writes the one deny and the first load's backstop adds nothing), and the bundle takes the channel captured at load only; a bundle that already answered is ended only after its bytes drained. The build sets an explicit mode on every runtime file (not only the bundles), refuses a native file that is not a regular file, and runs only when it is the script node started with (realpath comparison). Measured before the fix: a judge answering each request after 20 s let the hook run 41 s and end with a permit; a damaged runtime exited 1 with no decision.
- Fixed `npm run build:marketplace` on Windows: npm is run through `node` and `npm-cli.js` (spawning `npm.cmd` without a shell is refused with `EINVAL`), the archive is extracted with the bsdtar shipped in System32, and the runtime is built in a staging directory and swapped in only on success, so a failed build no longer deletes the committed `runtime/` first (the previous runtime is moved aside and restored if the swap fails). The build also sets the runtime file modes explicitly, refuses an `npm_execpath` that is not `npm-cli.js` and consults it last, and refuses a native file path that leaves the package it was extracted from.

## 0.4.1 - 2026-09-09

- Updated the exact npm dependency and committed universal runtime to `@atbash/sdk@0.7.1`.
- Made this repository Claude Code–exclusive: removed the Codex plugin manifest (`.codex-plugin/`), the Codex marketplace catalog (`.agents/plugins/marketplace.json`), the OpenAI skill interface file, and the Codex-era architecture and hook-protocol documents.
- Renamed the workspace from `@atbash/codex-plugin` to `@atbash/claude-plugin` and the root package to `atbash-claude-plugin`.
- Removed the legacy `ATBASH_CODEX_TIMEOUT_MS` timeout fallback; use `ATBASH_HOOK_TIMEOUT_MS`.
- Pointed security reporting and repository references at `Atbash-Ai/atbash-claude-plugin`.

## 0.4.0 - 2026-09-09

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
