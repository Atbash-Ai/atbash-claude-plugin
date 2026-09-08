import assert from "node:assert/strict";
import test from "node:test";

import type { Decision, ToolCallInput } from "@atbash/sdk";

import type { ToolCallGuard } from "../src/atbash/guard.js";
import { evaluatePreToolUse } from "../src/hook/runner.js";
import { makeHookInput } from "./fixtures.js";

function guardReturning(decision: Decision, calls: ToolCallInput[] = []): ToolCallGuard {
  return {
    async auditToolCall(input) {
      calls.push(input);
      return decision;
    },
  };
}

test("allows only a canonical ALLOW decision", async () => {
  const calls: ToolCallInput[] = [];
  const outcome = await evaluatePreToolUse(makeHookInput(), () =>
    guardReturning({ allow: true, verdict: "ALLOW", reason: "within policy" }, calls),
  );

  assert.deepEqual(outcome, { allow: true, source: "atbash" });
  assert.deepEqual(calls, [
    {
      toolName: "Bash",
      args: { cmd: "git status --short" },
      context: "source=claude-code; workspace=example; permission_mode=default",
    },
  ]);
});

test("includes the model in Atbash context when the host provides it", async () => {
  const calls: ToolCallInput[] = [];
  const outcome = await evaluatePreToolUse(makeHookInput({ model: "claude-opus-5" }), () =>
    guardReturning({ allow: true, verdict: "ALLOW" }, calls),
  );

  assert.deepEqual(outcome, { allow: true, source: "atbash" });
  assert.equal(
    calls[0]?.context,
    "source=claude-code; workspace=example; permission_mode=default; model=claude-opus-5",
  );
});

test("denies HOLD and includes its reference", async () => {
  const outcome = await evaluatePreToolUse(makeHookInput(), () =>
    guardReturning({
      allow: false,
      verdict: "HOLD",
      reason: "operator review required",
      toolCallId: "call-123",
    }),
  );

  assert.deepEqual(outcome, {
    allow: false,
    verdict: "HOLD",
    reason: "Atbash HOLD: operator review required Reference: call-123.",
  });
});

test("denies BLOCK and inconsistent decisions", async () => {
  const blocked = await evaluatePreToolUse(makeHookInput(), () =>
    guardReturning({ allow: false, verdict: "BLOCK", reason: "policy red line" }),
  );
  const inconsistent = await evaluatePreToolUse(makeHookInput(), () =>
    guardReturning({ allow: true, verdict: "ERROR", reason: "unexpected" }),
  );

  assert.equal(blocked.allow, false);
  assert.equal(blocked.allow ? undefined : blocked.verdict, "BLOCK");
  assert.equal(inconsistent.allow, false);
  assert.equal(inconsistent.allow ? undefined : inconsistent.verdict, "ERROR");
});

test("fails closed on configuration and runtime errors", async () => {
  const configurationError = await evaluatePreToolUse(makeHookInput(), () => {
    throw new Error("contains-sensitive-config");
  });
  const runtimeError = await evaluatePreToolUse(makeHookInput(), () => ({
    async auditToolCall() {
      throw new Error("contains-sensitive-runtime-data");
    },
  }));

  assert.deepEqual(configurationError, {
    allow: false,
    verdict: "ERROR",
    reason: "Atbash ERROR: configuration is missing or invalid.",
  });
  assert.deepEqual(runtimeError, {
    allow: false,
    verdict: "ERROR",
    reason: "Atbash ERROR: the safety check failed before a decision was returned.",
  });
});

test("judges every Atbash-named tool and fails closed without configuration", async () => {
  for (const toolName of [
    "mcp__atbash__status",
    "mcp__atbash__exec",
    "mcp__atbash__",
    "mcp__atbash_fake__status",
  ]) {
    const calls: ToolCallInput[] = [];
    const input = makeHookInput({ tool_name: toolName });
    const blocked = await evaluatePreToolUse(input, () =>
      guardReturning({ allow: false, verdict: "BLOCK", reason: "policy denial" }, calls),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.toolName, toolName);
    assert.equal(blocked.allow, false);
    assert.equal(blocked.allow ? undefined : blocked.verdict, "BLOCK");

    const unconfigured = await evaluatePreToolUse(input, () => {
      throw new Error("missing configuration");
    });
    assert.equal(unconfigured.allow, false);
    assert.equal(unconfigured.allow ? undefined : unconfigured.verdict, "ERROR");
  }
});

test("routes shell, patch, MCP, and other local tools through the guard", async () => {
  for (const toolName of ["Bash", "apply_patch", "mcp__github__get_issue", "view_image"]) {
    const calls: ToolCallInput[] = [];
    const outcome = await evaluatePreToolUse(makeHookInput({ tool_name: toolName }), () =>
      guardReturning({ allow: true, verdict: "ALLOW" }, calls),
    );

    assert.deepEqual(outcome, { allow: true, source: "atbash" });
    assert.equal(calls[0]?.toolName, toolName);
  }
});
