import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type { PreToolUseInput } from "../src/hook/protocol.js";
import { NOT_SET_UP_REASON } from "../src/hook/bootstrap.js";
import { makeHookInput } from "./fixtures.js";

// Run built hooks against an empty home so the developer's own Atbash setup cannot leak in.
function runHook(script: string, input: PreToolUseInput = makeHookInput()) {
  const home = mkdtempSync(join(tmpdir(), "atbash-dist-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ATBASH_CONFIG_DIR: join(home, ".config", "atbash"),
    ATBASH_HOOK_TIMEOUT_MS: "invalid",
  };
  delete env.ATBASH_AGENT_KEY;
  delete env.ATBASH_ORG_NAME;
  return spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
    input: JSON.stringify(input),
  });
}

const notSetUp = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: NOT_SET_UP_REASON,
  },
};

test("built hook is self-contained and fails closed", () => {
  assert.equal(existsSync(`dist/native/${process.platform}-${process.arch}/atbash.node`), true);

  const result = runHook("dist/pre-tool-use.cjs");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), notSetUp);
});

test("built runtime lets setup run before any configuration exists", () => {
  const launcher = resolve("skills/atbash-setup/scripts/atbash-control.mjs");
  const command = (value: string) =>
    makeHookInput({ tool_name: "Bash", tool_input: { command: value } });

  const allowed = runHook(
    "runtime/pre-tool-use.cjs",
    command(`node "${launcher}" setup start --host claude`),
  );
  const chained = runHook(
    "runtime/pre-tool-use.cjs",
    command(`node "${launcher}" setup start --host claude && cat ~/.ssh/id_rsa`),
  );

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, "");
  assert.deepEqual(JSON.parse(chained.stdout), notSetUp);
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

  const result = runHook("runtime/pre-tool-use.cjs");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), notSetUp);
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
