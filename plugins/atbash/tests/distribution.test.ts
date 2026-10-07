import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { makeHookInput } from "./fixtures.js";

interface BuildEnvironment {
  sdkPackage: string;
  endpoint?: string;
  chains?: Record<"public" | "private", { blockchainRid: string; nodeUrls: string[] }>;
}

interface RuntimeManifest {
  environment?: string;
  sdkVersion?: string;
  platforms?: Record<string, { package?: string; sha256?: string }>;
}

const environments = JSON.parse(readFileSync("build-environments.json", "utf8")) as Record<
  string,
  BuildEnvironment
>;

function runtimeManifest(): { manifest: RuntimeManifest; environment: BuildEnvironment } {
  const manifest = JSON.parse(readFileSync("runtime/manifest.json", "utf8")) as RuntimeManifest;
  const environment = environments[manifest.environment ?? ""];
  assert.ok(environment, `runtime/manifest.json names an unknown environment`);
  return { manifest, environment };
}

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
    devDependencies?: Record<string, string>;
  };
  const { manifest, environment } = runtimeManifest();
  const pinned =
    packageJson.dependencies?.[environment.sdkPackage] ??
    packageJson.devDependencies?.[environment.sdkPackage];

  assert.equal(manifest.sdkVersion, pinned?.replace(/^npm:@atbash\/sdk@/, ""));
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

test("marketplace runtime targets the environment recorded in its manifest", () => {
  const { manifest, environment } = runtimeManifest();
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const n = require("./runtime/atbash-native.cjs");
      process.stdout.write(JSON.stringify({
        endpoint: n.DEFAULT_ENDPOINT,
        public: { blockchainRid: n.DEFAULT_BLOCKCHAIN_RID, nodeUrls: n.defaultChromiaNodeUrls() },
        private: { blockchainRid: n.DEFAULT_PRIVATE_BLOCKCHAIN_RID, nodeUrls: n.defaultPrivateNodeUrls() },
      }));`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout) as { endpoint: string } & BuildEnvironment["chains"];

  if (environment.endpoint !== undefined) {
    assert.deepEqual(actual, { endpoint: environment.endpoint, ...environment.chains });
    return;
  }

  // Production keeps the SDK's own defaults and carries no other environment's values.
  assert.equal(manifest.environment, "prod");
  assert.equal(actual.endpoint, "https://atbash.ai");
  const bundles = readdirSync("runtime")
    .filter((name) => name.endsWith(".cjs"))
    .map((name) => readFileSync(join("runtime", name), "utf8").toLowerCase());
  for (const [name, other] of Object.entries(environments)) {
    if (other.endpoint === undefined) continue;
    const pinned = [
      new URL(other.endpoint).hostname,
      other.chains?.public.blockchainRid,
      other.chains?.private.blockchainRid,
    ];
    for (const value of pinned) {
      assert.ok(value);
      for (const bundle of bundles)
        assert.doesNotMatch(bundle, new RegExp(value.toLowerCase()), name);
    }
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
