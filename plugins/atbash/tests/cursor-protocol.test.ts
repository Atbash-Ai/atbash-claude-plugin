import assert from "node:assert/strict";
import test from "node:test";
import { executePreToolUse } from "../src/hook/cli.js";
import { parsePreToolUseInput } from "../src/hook/protocol.js";

const cursorInput = {
  hook_event_name: "preToolUse",
  cursor_version: "3.20.21",
  workspace_roots: ["/C:/workspace/example"],
  session_id: "cursor-session",
  tool_name: "Shell",
  tool_input: { command: "git status --short" },
};

test("Cursor payload reaches the judge with original tool arguments and host context", async () => {
  let calls = 0;
  const output = await executePreToolUse(JSON.stringify(cursorInput), {
    createGuard: () => ({
      async auditToolCall(input) {
        calls++;
        assert.equal(input.toolName, "Shell");
        assert.deepEqual(input.args, cursorInput.tool_input);
        assert.match(input.context ?? "", /source=cursor/);
        assert.match(input.context ?? "", /permission_mode=unknown/);
        return { allow: true, verdict: "ALLOW" };
      },
    }),
  });
  assert.equal(calls, 1);
  assert.equal(output, "");
  assert.equal(parsePreToolUseInput(JSON.stringify(cursorInput)).cwd, "C:/workspace/example");
});

test("Cursor BLOCK HOLD errors and inconsistent decisions remain denied", async () => {
  for (const decision of [
    { allow: false, verdict: "BLOCK" as const },
    { allow: false, verdict: "HOLD" as const },
    { allow: true, verdict: "BLOCK" as const },
    { allow: false, verdict: "ALLOW" as const },
  ]) {
    let calls = 0;
    const output = await executePreToolUse(JSON.stringify(cursorInput), {
      createGuard: () => ({
        async auditToolCall() {
          calls++;
          return decision;
        },
      }),
    });
    assert.equal(calls, 1);
    assert.equal(JSON.parse(output).hookSpecificOutput.permissionDecision, "deny");
  }
  const output = await executePreToolUse(JSON.stringify(cursorInput), {
    createGuard: () => {
      throw new Error("private detail");
    },
  });
  assert.match(output, /permissionDecision":"deny/);
  assert.doesNotMatch(output, /private detail/);
});

test("Cursor malformed metadata and missing tool arguments fail closed before judging", async () => {
  for (const override of [
    { cursor_version: undefined },
    { cursor_version: "" },
    { workspace_roots: [] },
    { workspace_roots: [4] },
    { workspace_roots: ["relative/path"] },
    { permission_mode: "" },
    { tool_name: "" },
    { session_id: "" },
    { tool_input: undefined },
    { hook_event_name: "postToolUse" },
  ]) {
    let calls = 0;
    const output = await executePreToolUse(JSON.stringify({ ...cursorInput, ...override }), {
      createGuard: () => {
        calls++;
        throw new Error("must not construct");
      },
    });
    assert.equal(calls, 0);
    assert.match(output, /permissionDecision":"deny/);
  }
});
