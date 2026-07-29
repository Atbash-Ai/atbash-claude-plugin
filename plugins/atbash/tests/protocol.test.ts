import assert from "node:assert/strict";
import test from "node:test";

import {
  HookProtocolError,
  parsePreToolUseInput,
  sanitizeReason,
  serializeDeny,
} from "../src/hook/protocol.js";
import { makeHookInput } from "./fixtures.js";

test("parses the Codex PreToolUse wire shape", () => {
  const input = makeHookInput();

  assert.deepEqual(parsePreToolUseInput(JSON.stringify(input)), input);
});

test("rejects malformed or incomplete hook input", () => {
  assert.throws(() => parsePreToolUseInput("not-json"), HookProtocolError);
  assert.throws(
    () => parsePreToolUseInput(JSON.stringify({ hook_event_name: "PreToolUse" })),
    HookProtocolError,
  );
});

test("serializes the verified Codex deny response", () => {
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
