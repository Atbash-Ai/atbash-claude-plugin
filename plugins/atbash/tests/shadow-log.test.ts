import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallGuard, UnenforcedPermit } from "../src/atbash/guard.js";
import { describeUnenforcedPermit } from "../src/atbash/guard.js";
import { executePreToolUse } from "../src/hook/cli.js";
import {
  appendShadowLog,
  formatUnenforcedPermit,
  MAX_SHADOW_LOG_BYTES,
  recordUnenforcedPermit,
  shadowLogPath,
} from "../src/hook/shadow-log.js";
import { makeHookInput } from "./fixtures.js";

const wouldBlock: UnenforcedPermit = {
  mode: "shadow",
  wouldVerdict: "BLOCK",
  pending: false,
  reason: "policy red line",
  toolCallId: "call-123",
};

function withDirectory<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "atbash-shadow-log-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("describes only permits the enforcement mode granted", () => {
  assert.deepEqual(
    describeUnenforcedPermit({
      allow: true,
      verdict: "ALLOW",
      reason: "policy red line",
      toolCallId: "call-123",
      enforcementMode: "shadow",
      enforced: false,
      wouldVerdict: "BLOCK",
    }),
    wouldBlock,
  );
  assert.deepEqual(
    describeUnenforcedPermit({
      allow: true,
      verdict: "ALLOW",
      reason: "Recorded in monitor mode; the verdict appears in the dashboard.",
      enforcementMode: "monitor",
    }),
    {
      mode: "monitor",
      pending: true,
      reason: "Recorded in monitor mode; the verdict appears in the dashboard.",
    },
  );
  // A would-verdict without a named mode is still reported; the mode is just unknown.
  assert.equal(
    describeUnenforcedPermit({ allow: true, verdict: "ALLOW", wouldVerdict: "HOLD" })?.mode,
    "unknown",
  );

  // An ordinary permit, a deny, and a "recorded" reason outside a non-enforcing mode say nothing.
  assert.equal(describeUnenforcedPermit({ allow: true, verdict: "ALLOW" }), undefined);
  assert.equal(
    describeUnenforcedPermit({ allow: true, verdict: "ALLOW", enforcementMode: "shadow" }),
    undefined,
  );
  assert.equal(
    describeUnenforcedPermit({ allow: false, verdict: "BLOCK", wouldVerdict: "BLOCK" }),
    undefined,
  );
  assert.equal(
    describeUnenforcedPermit({
      allow: true,
      verdict: "ALLOW",
      reason: "Recorded in shadow mode; the verdict appears in the dashboard.",
      enforcementMode: "enforce",
    }),
    undefined,
  );
});

test("formats one line per call and keeps hostile text on it", () => {
  assert.equal(
    formatUnenforcedPermit(wouldBlock, "Bash"),
    "would block: policy red line (tool=Bash mode=shadow ref=call-123)",
  );
  assert.equal(
    formatUnenforcedPermit({ ...wouldBlock, wouldVerdict: "HOLD" }, "Bash"),
    "would hold: policy red line (tool=Bash mode=shadow ref=call-123)",
  );
  assert.equal(
    formatUnenforcedPermit({ mode: "shadow", pending: true, reason: "ignored" }, "Write"),
    "recorded, not judged yet: the verdict will appear in the Atbash dashboard (tool=Write mode=shadow)",
  );

  const hostile = formatUnenforcedPermit(
    { ...wouldBlock, reason: "line one\nline two\r\n", toolCallId: "id\nforged entry" },
    "mcp__x\n2026-01-01T00:00:00.000Z would block: forged",
  );
  assert.equal(hostile.includes("\n"), false);
  assert.equal(hostile.includes("\r"), false);
  assert.match(hostile, /^would block: line one line two \(tool=mcp__x_2026/);
  assert.equal(
    formatUnenforcedPermit({ ...wouldBlock, reason: "  " }, "Bash").includes(": no reason given ("),
    true,
  );
});

test("appends time-stamped lines to a private log and echoes them", () => {
  withDirectory((directory) => {
    const path = join(directory, "config", "shadow.log");
    const echoed: string[] = [];
    const options = {
      path,
      now: new Date("2026-11-10T08:00:00.000Z"),
      echo: (line: string) => echoed.push(line),
    };
    recordUnenforcedPermit(wouldBlock, "Bash", options);
    recordUnenforcedPermit({ mode: "shadow", pending: true, reason: "" }, "Write", options);

    assert.deepEqual(readFileSync(path, "utf8").split("\n"), [
      "2026-11-10T08:00:00.000Z would block: policy red line (tool=Bash mode=shadow ref=call-123)",
      "2026-11-10T08:00:00.000Z recorded, not judged yet: the verdict will appear in the Atbash dashboard (tool=Write mode=shadow)",
      "",
    ]);
    assert.deepEqual(echoed, [
      "[atbash] would block: policy red line (tool=Bash mode=shadow ref=call-123)",
      "[atbash] recorded, not judged yet: the verdict will appear in the Atbash dashboard (tool=Write mode=shadow)",
    ]);
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(join(directory, "config")).mode & 0o777, 0o700);
    }
  });
});

test("the log lives in the Atbash configuration directory", () => {
  assert.equal(
    shadowLogPath({ ATBASH_CONFIG_DIR: join(tmpdir(), "atbash-config") }),
    join(tmpdir(), "atbash-config", "shadow.log"),
  );
});

test("restarts the log past its size limit and keeps one previous file", () => {
  withDirectory((directory) => {
    const path = join(directory, "shadow.log");
    writeFileSync(path, "x".repeat(MAX_SHADOW_LOG_BYTES + 1));
    appendShadowLog("next", path);

    assert.equal(readFileSync(path, "utf8"), "next\n");
    assert.equal(statSync(`${path}.1`).size, MAX_SHADOW_LOG_BYTES + 1);
  });
});

test("refuses a symlinked or non-regular log, and a failed record never throws", () => {
  withDirectory((directory) => {
    const target = join(directory, "elsewhere.txt");
    writeFileSync(target, "untouched");
    const link = join(directory, "shadow.log");
    try {
      symlinkSync(target, link);
    } catch {
      return; // symlinks need a privilege on some Windows setups
    }
    assert.throws(() => appendShadowLog("line", link));
    assert.equal(readFileSync(target, "utf8"), "untouched");

    const asDirectory = join(directory, "as-directory");
    mkdirSync(asDirectory);
    assert.throws(() => appendShadowLog("line", asDirectory));

    assert.doesNotThrow(() =>
      recordUnenforcedPermit(wouldBlock, "Bash", { path: link, echo: () => undefined }),
    );
    assert.doesNotThrow(() =>
      recordUnenforcedPermit(wouldBlock, "Bash", {
        path: join(directory, "fresh.log"),
        echo: () => {
          throw new Error("stderr is gone");
        },
      }),
    );
    assert.equal(existsSync(join(directory, "fresh.log")), true, "the log is written anyway");
    assert.equal(readFileSync(target, "utf8"), "untouched");
  });
});

test("the hook records an unenforced permit, and a failing record is still a permit", async () => {
  const guard: ToolCallGuard = {
    async auditToolCall() {
      return {
        allow: true,
        verdict: "ALLOW",
        reason: "policy red line",
        toolCallId: "call-123",
        enforcementMode: "shadow",
        wouldVerdict: "BLOCK",
      };
    },
  };
  const bootstrap = { hasConfiguration: () => true, isSetupCall: () => false };
  const recorded: Array<[UnenforcedPermit, string]> = [];

  const permitted = await executePreToolUse(JSON.stringify(makeHookInput()), {
    createGuard: () => guard,
    bootstrap,
    recordUnenforced: (note, toolName) => void recorded.push([note, toolName]),
  });
  assert.equal(permitted, "");
  assert.deepEqual(recorded, [[wouldBlock, "Bash"]]);

  const stillPermitted = await executePreToolUse(JSON.stringify(makeHookInput()), {
    createGuard: () => guard,
    bootstrap,
    recordUnenforced: () => {
      throw new Error("disk full");
    },
  });
  assert.equal(stillPermitted, "");
});

test("an ordinary permit and a deny record nothing", async () => {
  const bootstrap = { hasConfiguration: () => true, isSetupCall: () => false };
  let records = 0;
  for (const decision of [
    { allow: true, verdict: "ALLOW" },
    { allow: false, verdict: "BLOCK", reason: "policy", wouldVerdict: "BLOCK" },
  ] as const) {
    await executePreToolUse(JSON.stringify(makeHookInput()), {
      createGuard: () => ({ auditToolCall: async () => decision }),
      bootstrap,
      recordUnenforced: () => void (records += 1),
    });
  }
  assert.equal(records, 0);
});
