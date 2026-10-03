import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { makeHookInput } from "./fixtures.js";

test("built hook is self-contained and fails closed", () => {
  assert.equal(existsSync(`dist/native/${process.platform}-${process.arch}/atbash.node`), true);

  const result = spawnSync(process.execPath, ["dist/pre-tool-use.cjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ATBASH_HOOK_TIMEOUT_MS: "invalid",
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

test("marketplace runtime includes every supported native target", () => {
  const platforms = ["darwin-arm64", "linux-arm64", "linux-x64", "win32-x64"] as const;
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const manifest = JSON.parse(readFileSync("runtime/manifest.json", "utf8")) as {
    sdkVersion?: string;
    platforms?: Record<string, { package?: string; sha256?: string }>;
  };

  assert.equal(manifest.sdkVersion, packageJson.dependencies?.["@atbash/sdk"]);
  assert.equal(existsSync("runtime/licenses/atbash-sdk.LICENSE"), true);
  assert.equal(existsSync("runtime/control.cjs"), true);

  for (const platform of platforms) {
    const nativePath = `runtime/native/${platform}/atbash.node`;
    assert.equal(existsSync(nativePath), true, platform);
    assert.match(manifest.platforms?.[platform]?.package ?? "", /^@atbash\/sdk-/);
    assert.equal(
      createHash("sha256").update(readFileSync(nativePath)).digest("hex"),
      manifest.platforms?.[platform]?.sha256,
      platform,
    );
  }

  const result = spawnSync(process.execPath, ["runtime/pre-tool-use.cjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ATBASH_HOOK_TIMEOUT_MS: "invalid",
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

test("shipped runtime never sends the workspace folder name", () => {
  // Claude Code runs the committed runtime, not src, and the judge context is recorded on a
  // public chain. The context builder must be present (so this check is not vacuous) and must
  // not emit the workspace fact.
  for (const bundle of ["runtime/pre-tool-use.cjs", "runtime/index.cjs"]) {
    const source = readFileSync(bundle, "utf8");
    assert.match(source, /source=claude-code/, bundle);
    assert.doesNotMatch(source, /workspace=/, bundle);
  }
});

test("marketplace package includes setup and management skills", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    files?: string[];
  };
  const skill = readFileSync("skills/atbash-setup/SKILL.md", "utf8");
  const manageSkill = readFileSync("skills/atbash-manage/SKILL.md", "utf8");
  const setupLauncher = readFileSync("skills/atbash-setup/scripts/atbash-control.mjs", "utf8");

  assert.equal(packageJson.files?.includes("skills"), true);
  assert.match(skill, /^---\r?\nname: atbash-setup\r?\n/);
  assert.doesNotMatch(skill, /\[TODO:/);
  assert.match(skill, /--host claude/);
  assert.match(manageSkill, /^---\r?\nname: atbash-manage\r?\n/);
  assert.match(manageSkill, /--host claude/);
  assert.match(setupLauncher, /runtime\/control\.cjs/);
});
