# Changelog

All notable changes to this project are documented here.

## Unreleased

- Updated the exact npm dependency to `@atbash/sdk@0.6.1`.
- Added SDK organization-based chain resolution for Private and Swarm judgment requests.

## 0.1.0 - 2026-07-22

- Added the activatable `atbash` Codex plugin and repo-local marketplace.
- Added catch-all `PreToolUse` enforcement through exact npm dependency `@atbash/sdk@0.6.0`.
- Added fail-closed handling for configuration, transport, timeout, malformed input, and inconsistent decisions.
- Added `ALLOW`, `HOLD`, `BLOCK`, and `ERROR` mapping with safe user-visible reasons.
- Added the reserved `mcp__atbash__*` recursion bypass.
- Added a self-contained platform build with the npm-selected native SDK binding.
- Added agent status diagnostics, automated tests, CI, protocol evidence, and security documentation.
