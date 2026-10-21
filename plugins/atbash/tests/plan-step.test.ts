/**
 * The onboarding plan step against self-protection. Self-protection guards the whole Atbash
 * configuration directory; the guided setup and management flows still have to write a plan to
 * `<config>/plans/<job-id>.json` and hand it to the helper. Only those two exact steps pass
 * self-protection (they are still judged); everything else under the directory stays protected.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Decision } from "@atbash/sdk";

import { createSetupBootstrap, isPlanStep } from "../src/hook/bootstrap.js";
import { evaluatePreToolUse } from "../src/hook/runner.js";
import { makeHookInput } from "./fixtures.js";

const JOB = "3f1c2a9e-1b2c-4d5e-8f90-123456789abc";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "atbash-plan-step-"));
  const home = join(base, "home");
  const config = join(home, ".config", "atbash");
  const plans = join(config, "plans");
  const plugin = join(base, "plugin");
  mkdirSync(plans, { recursive: true });
  for (const skill of ["atbash-setup", "atbash-manage"]) {
    mkdirSync(join(plugin, "skills", skill, "scripts"), { recursive: true });
    writeFileSync(join(plugin, "skills", skill, "scripts", "atbash-control.mjs"), "");
  }
  writeFileSync(join(config, "config.json"), "{}");
  const options = { pluginRoot: plugin, env: { ATBASH_CONFIG_DIR: config } };
  return {
    home,
    config,
    plans,
    plugin,
    options,
    planFile: join(plans, `${JOB}.json`),
    launcher: (skill: string) => join(plugin, "skills", skill, "scripts", "atbash-control.mjs"),
    cleanup: () => rmSync(base, { force: true, recursive: true }),
  };
}

const write = (file_path: string) =>
  makeHookInput({ tool_name: "Write", tool_input: { file_path, content: "{}" } });
const bash = (command: string) => makeHookInput({ tool_name: "Bash", tool_input: { command } });

test("a plan write and the exact setup/manage plan commands are plan steps", () => {
  const f = fixture();
  try {
    assert.equal(isPlanStep(write(f.planFile), f.options), true, "new plan file");
    writeFileSync(f.planFile, "{}");
    assert.equal(isPlanStep(write(f.planFile), f.options), true, "existing plan file");
    const setup = `node "${f.launcher("atbash-setup")}" setup plan ${JOB} --input ${f.planFile}`;
    const manage = `node "${f.launcher("atbash-manage")}" manage plan ${JOB} --input ${f.planFile}`;
    assert.equal(isPlanStep(bash(setup), f.options), true, "setup plan");
    assert.equal(isPlanStep(bash(manage), f.options), true, "manage plan");
  } finally {
    f.cleanup();
  }
});

test("nothing else under the configuration directory is a plan step", () => {
  const f = fixture();
  try {
    const notPlans = [
      join(f.config, "config.json"),
      join(f.config, "credentials", `${JOB}.json`),
      join(f.config, "hosts", "claude.json"),
      join(f.plans, "..", "config.json"),
      join(f.plans, "nested", `${JOB}.json`),
      join(f.plans, "bad name.json"),
      join(f.plans, `${JOB}.txt`),
      `plans/${JOB}.json`,
    ];
    for (const path of notPlans) {
      assert.equal(isPlanStep(write(path), f.options), false, path);
    }
    // Only Write: an Edit or a MultiEdit of a plan is not the onboarding step.
    const edit = makeHookInput({
      tool_name: "Edit",
      tool_input: { file_path: f.planFile, old_string: "{}", new_string: "[]" },
    });
    assert.equal(isPlanStep(edit, f.options), false, "Edit");
  } finally {
    f.cleanup();
  }
});

test("a plan file or plans directory that is a symlink is not a plan step", () => {
  const f = fixture();
  try {
    symlinkSync(join(f.config, "config.json"), f.planFile);
    assert.equal(isPlanStep(write(f.planFile), f.options), false, "symlinked plan file");
    const command = `node "${f.launcher("atbash-setup")}" setup plan ${JOB} --input ${f.planFile}`;
    assert.equal(isPlanStep(bash(command), f.options), false, "symlinked plan via command");
  } finally {
    f.cleanup();
  }
  const g = fixture();
  try {
    rmSync(g.plans, { recursive: true });
    symlinkSync(g.config, g.plans);
    assert.equal(isPlanStep(write(g.planFile), g.options), false, "symlinked plans directory");
  } finally {
    g.cleanup();
  }
});

test("only the exact plan command form is a plan step", () => {
  const f = fixture();
  try {
    const setup = `"${f.launcher("atbash-setup")}"`;
    const other = join(f.plans, "other.json");
    for (const command of [
      `node ${setup} setup plan ${JOB} --input ${f.planFile} && cat ~/.ssh/id_rsa`,
      `node ${setup} setup plan ${JOB} --input ${f.planFile} --service https://evil.example`,
      `node ${setup} setup plan ${JOB} --input ${other}`,
      `node ${setup} setup plan other --input ${f.planFile}`,
      `node ${setup} manage plan ${JOB} --input ${f.planFile}`,
      `node ${setup} setup continue ${JOB}`,
      `node ${setup} setup plan ${JOB} --input ${join(f.config, "config.json")}`,
      `node /tmp/atbash-control.mjs setup plan ${JOB} --input ${f.planFile}`,
      `cp /tmp/x.json ${f.planFile}`,
    ]) {
      assert.equal(isPlanStep(bash(command), f.options), false, command);
    }
  } finally {
    f.cleanup();
  }
});

test("the runner lets a plan step reach the judge and keeps the rest of the directory protected", async () => {
  const f = fixture();
  try {
    const bootstrap = createSetupBootstrap(f.options);
    const protection = {
      cwd: f.home,
      env: { HOME: f.home },
      homeDir: f.home,
      pluginRoots: [f.plugin],
    };
    let judged = 0;
    const allow = () => ({
      async auditToolCall(): Promise<Decision> {
        judged += 1;
        return { allow: true, verdict: "ALLOW" };
      },
    });

    const plan = await evaluatePreToolUse(write(f.planFile), allow, bootstrap, protection);
    assert.deepEqual(plan, { allow: true, source: "atbash" });
    assert.equal(judged, 1, "the plan write was judged");

    const config = await evaluatePreToolUse(
      write(join(f.config, "config.json")),
      allow,
      bootstrap,
      protection,
    );
    assert.equal(config.allow, false);
    assert.equal(judged, 1, "a config write never reaches the judge");
    if (!config.allow) assert.match(config.reason, /Atbash key and configuration/);
  } finally {
    f.cleanup();
  }
});

test("a self-protection check that fails is a deny, even for a setup call before configuration", async () => {
  const bootstrap = { hasConfiguration: () => false, isSetupCall: () => true };
  // pluginRoots that cannot be iterated makes the check itself throw on any shell command (a Skill
  // call has nothing for the check to read, so it would never get that far).
  const broken = {
    cwd: "/",
    env: {},
    homeDir: "/",
    pluginRoots: null as unknown as string[],
  };
  const outcome = await evaluatePreToolUse(
    bash("node /opt/plugins/atbash/skills/atbash-setup/scripts/atbash-control.mjs setup start"),
    () => {
      throw new Error("no configuration");
    },
    bootstrap,
    broken,
  );
  assert.equal(outcome.allow, false);
  if (!outcome.allow) assert.match(outcome.reason, /self-protection check failed/);
});
