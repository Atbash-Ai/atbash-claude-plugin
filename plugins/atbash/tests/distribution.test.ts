import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { makeHookInput } from "./fixtures.js";

test("built hook is self-contained and fails closed", () => {
  assert.equal(existsSync("dist/atbash.node"), true);

  const result = spawnSync(process.execPath, ["dist/pre-tool-use.cjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ATBASH_CODEX_TIMEOUT_MS: "invalid",
    },
    input: JSON.stringify(makeHookInput()),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Atbash ERROR: configuration is missing or invalid.",
    },
  });
});
