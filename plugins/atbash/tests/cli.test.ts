import assert from "node:assert/strict";
import test from "node:test";

import type { Decision } from "@atbash/sdk";

import type { ToolCallGuard } from "../src/atbash/guard.js";
import { executePreToolUse } from "../src/hook/cli.js";
import { makeHookInput } from "./fixtures.js";

function guard(decision: Decision): ToolCallGuard {
  return {
    async auditToolCall() {
      return decision;
    },
  };
}

test("successful allow produces no hook decision output", async () => {
  const output = await executePreToolUse(JSON.stringify(makeHookInput()), {
    createGuard: () => guard({ allow: true, verdict: "ALLOW" }),
  });

  assert.equal(output, "");
});

test("deny produces the Claude Code permissionDecision wire shape", async () => {
  const output = await executePreToolUse(JSON.stringify(makeHookInput()), {
    createGuard: () => guard({ allow: false, verdict: "BLOCK", reason: "blocked" }),
  });

  assert.deepEqual(JSON.parse(output), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Atbash BLOCK: blocked",
    },
  });
});

test("invalid input fails closed without echoing the input", async () => {
  const secret = "secret-that-must-not-appear";
  const output = await executePreToolUse(secret);

  assert.doesNotMatch(output, new RegExp(secret));
  assert.match(output, /permissionDecision":"deny/);
});
