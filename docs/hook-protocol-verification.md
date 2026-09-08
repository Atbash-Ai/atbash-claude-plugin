# Codex Hook Protocol Verification

- Verification date: 2026-07-22
- Codex build: `codex-cli 0.144.0-alpha.4`
- Plugin: `atbash` `0.1.0`
- SDK: `@atbash/sdk@0.6.1`

## Verified input

The hook accepts a single JSON object on standard input with the following required fields:

- `hook_event_name` equal to `PreToolUse`
- `cwd`, `model`, `permission_mode`, `session_id`, `tool_name`, `tool_use_id`, and `turn_id` as strings
- `tool_input` as an object
- `transcript_path` as a string or `null`

Codex may also send `agent_id` and `agent_type`. Unknown fields are ignored. The implementation reads at most 1 MiB, validates the required shape, and does not read the transcript file.

## Verified output

Allow is exit code 0 with no standard output. Deny is exit code 0 with this event-specific JSON shape:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "non-empty safe reason"
  }
}
```

Current Codex accepts `deny` for `PreToolUse`. It does not accept `allow` or `ask` in `permissionDecision`; a successful allow therefore emits no output. Legacy top-level `decision: "approve"` is not used. Unsupported output and hook process failures are not relied on for enforcement because Codex can report the hook failure and continue the tool call.

## Coverage tests

Automated tests verify:

- strict input parsing and malformed-input denial;
- canonical allow and deny serialization;
- `ALLOW`, `HOLD`, `BLOCK`, inconsistent output, and thrown-error mapping;
- reason normalization and length bounds;
- shell, patch, non-Atbash MCP, and another local function-tool name reaching the SDK adapter;
- Atbash-named tools (including status, execution, bare-prefix, and look-alike names) reaching the guard and failing closed when configuration is unavailable;
- missing/invalid configuration failing closed;
- bounded stdin handling;
- status-state mapping without raw error leakage; and
- a self-contained built hook loading its embedded native SDK binding.

The catch-all matcher applies to the local tool paths Codex exposes to `PreToolUse`. Hosted web search and tools that opt out of hooks remain outside hook coverage.

## Installation and live probe

The initial local verification registered the repository as the `personal` marketplace, and `atbash@personal` was installed and reported by Codex as enabled. The plugin cache contained the compiled hook and embedded platform-native Atbash binding. The published marketplace is now named `atbash-ai`, so Git-backed installations use `atbash@atbash-ai`.

An ephemeral Codex task was run with hook trust bypass enabled only for the vetted test invocation. It attempted the read-only shell command `pwd` while `ATBASH_CODEX_TIMEOUT_MS=invalid` forced the configuration-error path. Codex returned:

```text
Command blocked by PreToolUse hook: Atbash ERROR: configuration is missing or invalid.
```

The command did not execute. This demonstrates that the installed plugin is discovered, active, and able to prevent a supported tool call before execution.

## Activation and trust

Codex hashes non-managed hook definitions. A newly installed or changed Atbash hook is skipped until reviewed and trusted through `/hooks`. The test-only `--dangerously-bypass-hook-trust` flag is not part of normal installation guidance. Users activate or deactivate the plugin through Codex's plugin controls.

## Git marketplace packaging

Version 0.2.0 adds a committed universal runtime to the marketplace snapshot. Automated tests verify the SDK version, presence of every supported native target, recorded SHA-256 checksums, and execution of the current platform's hook. CI regenerates the runtime from the pinned npm SDK and rejects any uncommitted difference.
