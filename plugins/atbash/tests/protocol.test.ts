import assert from "node:assert/strict";
import test from "node:test";

import {
  HookProtocolError,
  parsePreToolUseInput,
  sanitizeReason,
  serializeDeny,
} from "../src/hook/protocol.js";
import { makeHookInput } from "./fixtures.js";

test("parses the Claude Code PreToolUse wire shape", () => {
  const input = makeHookInput();

  assert.deepEqual(parsePreToolUseInput(JSON.stringify(input)), input);
});

test("parses optional host metadata when present", () => {
  const input = makeHookInput({
    model: "claude-opus-5",
    tool_use_id: "tool-use-test",
    turn_id: "turn-test",
    agent_id: "agent-test",
    agent_type: "general-purpose",
  });

  assert.deepEqual(parsePreToolUseInput(JSON.stringify(input)), input);
});

test("parses input without transcript_path and with a null transcript_path", () => {
  const withoutTranscript = makeHookInput();
  delete withoutTranscript.transcript_path;
  assert.deepEqual(parsePreToolUseInput(JSON.stringify(withoutTranscript)), withoutTranscript);

  const nullTranscript = makeHookInput({ transcript_path: null });
  assert.deepEqual(parsePreToolUseInput(JSON.stringify(nullTranscript)), nullTranscript);
});

test("rejects malformed or incomplete hook input", () => {
  assert.throws(() => parsePreToolUseInput("not-json"), HookProtocolError);
  assert.throws(
    () => parsePreToolUseInput(JSON.stringify({ hook_event_name: "PreToolUse" })),
    HookProtocolError,
  );
  assert.throws(
    () => parsePreToolUseInput(JSON.stringify(makeHookInput({ permission_mode: "" }))),
    HookProtocolError,
  );
  assert.throws(
    () => parsePreToolUseInput(JSON.stringify(makeHookInput({ transcript_path: 5 as never }))),
    HookProtocolError,
  );
  assert.throws(
    () => parsePreToolUseInput(JSON.stringify(makeHookInput({ model: 5 as never }))),
    HookProtocolError,
  );
});

test("serializes the Claude Code deny response", () => {
  assert.deepEqual(JSON.parse(serializeDeny("Atbash BLOCK: denied")), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Atbash BLOCK: denied",
    },
  });
});

test("normalizes and bounds user-visible reasons", () => {
  assert.equal(sanitizeReason("  multiple\n spaces  ", "fallback"), "multiple spaces");
  assert.equal(sanitizeReason("", "fallback"), "fallback");
  assert.equal(sanitizeReason("x".repeat(900), "fallback").length, 800);
});
