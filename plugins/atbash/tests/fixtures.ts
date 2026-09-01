import type { PreToolUseInput } from "../src/hook/protocol.js";

/**
 * A representative Claude Code PreToolUse payload. Claude Code always sends
 * the required fields below; optional fields exercised by individual tests
 * are added through overrides.
 */
export function makeHookInput(overrides: Partial<PreToolUseInput> = {}): PreToolUseInput {
  return {
    hook_event_name: "PreToolUse",
    cwd: "/workspace/example",
    permission_mode: "default",
    session_id: "session-test",
    tool_input: { cmd: "git status --short" },
    tool_name: "Bash",
    transcript_path: "/workspace/example/.claude/transcript.jsonl",
    ...overrides,
  };
}
