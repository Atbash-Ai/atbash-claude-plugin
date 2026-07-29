import type { PreToolUseInput } from "../src/hook/protocol.js";

export function makeHookInput(overrides: Partial<PreToolUseInput> = {}): PreToolUseInput {
  return {
    hook_event_name: "PreToolUse",
    cwd: "/workspace/example",
    model: "gpt-test",
    permission_mode: "default",
    session_id: "session-test",
    tool_input: { cmd: "git status --short" },
    tool_name: "Bash",
    tool_use_id: "tool-use-test",
    transcript_path: null,
    turn_id: "turn-test",
    ...overrides,
  };
}
