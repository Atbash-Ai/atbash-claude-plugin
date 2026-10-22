/**
 * The setup helper against self-protection. A real install runs the helper from
 * `~/.claude/plugins/cache/…`, a path self-protection guards, so every setup command used to be
 * denied as a change to installed Claude Code plugins. Only the exact helper commands pass
 * self-protection (they are still judged); disconnecting and anything else naming the plugin
 * cache stays denied.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Decision } from "@atbash/sdk";

import { createSetupBootstrap, isHelperStep } from "../src/hook/bootstrap.js";
import { evaluatePreToolUse } from "../src/hook/runner.js";
import { makeHookInput } from "./fixtures.js";

const JOB = "3f1c2a9e-1b2c-4d5e-8f90-123456789abc";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "atbash-helper-step-"));
  const home = join(base, "home");
  const config = join(home, ".config", "atbash");
  // Where Claude Code puts a plugin installed from a marketplace.
  const plugin = join(home, ".claude", "plugins", "cache", "atbash-ai", "atbash", "0.5.0");
  for (const skill of ["atbash-setup", "atbash-manage"]) {
    mkdirSync(join(plugin, "skills", skill, "scripts"), { recursive: true });
    writeFileSync(join(plugin, "skills", skill, "scripts", "atbash-control.mjs"), "");
  }
  const options = { pluginRoot: plugin, env: { ATBASH_CONFIG_DIR: config } };
  return {
    home,
    config,
    plugin,
    options,
    protection: { cwd: home, env: { HOME: home }, homeDir: home, pluginRoots: [plugin] },
    launcher: (skill: string) =>
      `"${join(plugin, "skills", skill, "scripts", "atbash-control.mjs")}"`,
    configure: () => {
      mkdirSync(join(config, "hosts"), { recursive: true });
      writeFileSync(join(config, "hosts", "claude.json"), "{}");
    },
    cleanup: () => rmSync(base, { force: true, recursive: true }),
  };
}

const bash = (command: string, cwd = "/workspace/example") =>
  makeHookInput({ tool_name: "Bash", tool_input: { command }, cwd });

const notConfigured = () => {
  throw new Error("missing configuration");
};

test("setup from the plugin cache is not mistaken for changing installed plugins", async () => {
  const f = fixture();
  try {
    const bootstrap = createSetupBootstrap(f.options);
    for (const command of [
      `node ${f.launcher("atbash-setup")} setup start --host claude`,
      `node ${f.launcher("atbash-setup")} setup inspect ${JOB}`,
      `node ${f.launcher("atbash-setup")} setup continue ${JOB}`,
      `node ${f.launcher("atbash-setup")} setup cancel ${JOB}`,
      `node ${f.launcher("atbash-setup")} profile connect ${JOB}`,
      `node ${f.launcher("atbash-setup")} profile list --host claude`,
    ]) {
      const outcome = await evaluatePreToolUse(
        bash(command),
        notConfigured,
        bootstrap,
        f.protection,
      );
      assert.deepEqual(outcome, { allow: true, source: "setup-bootstrap" }, command);
    }
  } finally {
    f.cleanup();
  }
});

test("disconnecting, chaining, or anything else naming the plugin cache stays denied", async () => {
  const f = fixture();
  try {
    const bootstrap = createSetupBootstrap(f.options);
    for (const command of [
      `node ${f.launcher("atbash-setup")} profile disconnect --host claude`,
      `node ${f.launcher("atbash-setup")} setup start --host claude && rm -rf ${f.plugin}`,
      `node ${f.launcher("atbash-setup")} setup start --service https://evil.example`,
      `node ${f.launcher("atbash-setup")} manage start --host claude`,
      `rm -rf ${f.plugin}`,
      `node ${join(f.plugin, "runtime", "control.cjs")} setup start --host claude`,
    ]) {
      const outcome = await evaluatePreToolUse(
        bash(command),
        notConfigured,
        bootstrap,
        f.protection,
      );
      assert.equal(outcome.allow, false, command);
      if (!outcome.allow) assert.match(outcome.reason, /installed Claude Code plugins/, command);
    }
  } finally {
    f.cleanup();
  }
});

test("management commands pass only through the management launcher", () => {
  const f = fixture();
  try {
    for (const action of [
      "start --host claude",
      `inspect ${JOB}`,
      `continue ${JOB}`,
      `cancel ${JOB}`,
    ]) {
      const command = `node ${f.launcher("atbash-manage")} manage ${action}`;
      assert.equal(isHelperStep(bash(command), f.options), true, command);
    }
    assert.equal(
      isHelperStep(
        bash(`node ${f.launcher("atbash-manage")} setup start --host claude`),
        f.options,
      ),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test("profile switch re-points Atbash, so it passes only before any configuration exists", () => {
  const f = fixture();
  try {
    const command = bash(
      `node ${f.launcher("atbash-setup")} profile switch --host claude --profile p1`,
    );
    assert.equal(isHelperStep(command, f.options), true, "setup mode");
    f.configure();
    assert.equal(isHelperStep(command, f.options), false, "configured");
  } finally {
    f.cleanup();
  }
});

test("a helper command from the plugin cache is still judged once Atbash is configured", async () => {
  const f = fixture();
  try {
    f.configure();
    let judged = 0;
    const guard = () => ({
      async auditToolCall(): Promise<Decision> {
        judged += 1;
        return { allow: false, verdict: "BLOCK", reason: "policy" };
      },
    });
    const outcome = await evaluatePreToolUse(
      bash(`node ${f.launcher("atbash-manage")} manage start --host claude`),
      guard,
      createSetupBootstrap(f.options),
      f.protection,
    );
    assert.equal(judged, 1);
    assert.equal(outcome.allow ? undefined : outcome.verdict, "BLOCK");
  } finally {
    f.cleanup();
  }
});
