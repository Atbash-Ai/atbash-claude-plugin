/**
 * The host boundary: what Claude Code does with the hook process itself, not with its verdict.
 *
 * Claude Code's hooks reference: a hook that times out does not block the tool call, and a hook
 * that exits with any code other than 0 or 2 lets the action proceed as a non-blocking error.
 * So two things outside the verdict logic decide whether the gate exists at all:
 *   - the hook must answer before hooks.json's `timeout` (35 s), whatever the judge does;
 *   - the hook must answer with a deny even when its own runtime cannot load or crashes.
 * Both were red on 0.4.1 (measured 40.8 s for a slow-but-alive judge; exit 1 with no output for
 * a damaged runtime). These tests spawn the BUILT entry point, as the host does.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateKeypair } from "@atbash/sdk";

import { makeHookInput } from "./fixtures.js";

const ENTRY = "dist/pre-tool-use.cjs";
const DENY_SHAPE = /"permissionDecision":"deny"/;

// How the bundled hook hands its decision to the shim: an in-process function the shim installs
// before loading the bundle (src/hook/protocol.ts HOOK_ANSWER_CHANNEL). Fixtures that stand in for
// the bundle answer the same way; stdout is no longer a decision channel at all.
const ANSWER = 'globalThis[Symbol.for("atbash.hook.answer")]';

interface JudgeOptions {
  delayMs: number;
  verdict?: "ALLOW" | "BLOCK";
}

async function startJudge({ delayMs, verdict = "ALLOW" }: JudgeOptions) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    hits.push(`${req.method} ${url.pathname}`);
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const answer = (body: unknown) => setTimeout(() => res.end(JSON.stringify(body)), delayMs);
      if (url.pathname === "/api/ai/exists") {
        answer({
          registered: true,
          pubkey: url.searchParams.get("pubkey"),
          org_encryption_pubkey: null,
        });
      } else if (url.pathname === "/api/risk-engine") {
        answer({ policy: "", is_custom: false, default_policy: "default", is_jailed: false });
      } else if (url.pathname === "/api/v1/judge") {
        answer(
          verdict === "BLOCK"
            ? {
                verdict: "BLOCK",
                action_type: "block",
                allow: false,
                reason: "denied by the test judge",
                tool_call_id: "tc-1",
              }
            : {
                verdict: "ALLOW",
                action_type: "allow",
                allow: true,
                reason: "routine",
                tool_call_id: "tc-1",
              },
        );
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  wallMs: number;
}

function runHook(entry: string, env: NodeJS.ProcessEnv, cwd = process.cwd()): Promise<RunResult> {
  const home = mkdtempSync(join(tmpdir(), "atbash-hook-home-"));
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], {
      cwd,
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
        HOME: home,
        USERPROFILE: home,
        HONEYCOMB_API_KEY: "",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(JSON.stringify(makeHookInput()));
    child.on("close", (code) => {
      rmSync(home, { force: true, recursive: true });
      resolve({ code, stdout, stderr, wallMs: Date.now() - started });
    });
  });
}

test("a slow-but-alive judge is denied before the host's 35 s hook timeout", async () => {
  // Two sequential SDK requests, each answered after 20 s: 0.4.1 waited for both (40.8 s) and
  // the host had already let the tool run. The hook must give up and deny well inside 35 s.
  const judge = await startJudge({ delayMs: 20_000 });
  try {
    const result = await runHook(ENTRY, {
      ATBASH_ENDPOINT: judge.endpoint,
      ATBASH_AGENT_KEY: generateKeypair().priv_key,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, DENY_SHAPE, `no deny on stdout: ${JSON.stringify(result.stdout)}`);
    assert.match(result.stdout, /did not finish/, result.stdout);
    assert.ok(
      result.wallMs < 34_000,
      `hook answered after ${result.wallMs} ms, past the host timeout`,
    );
    assert.ok(judge.hits.length >= 1, "the judge was never contacted");
  } finally {
    await judge.close();
  }
});

test("the shipped entry point is a small un-bundled shim in front of the bundled hook", () => {
  // The shim is what makes the next two tests possible: it must not itself be the megabyte bundle
  // whose load failure it guards against.
  for (const entry of [ENTRY, "runtime/pre-tool-use.cjs"]) {
    const size = statSync(entry).size;
    // The bundle is over a megabyte; the shim is a documentation-heavy 17 KB. The bound sits
    // between the two, not at the shim's current size.
    assert.ok(size < 32_768, `${entry} is ${size} bytes - it should be the shim, not the bundle`);
    assert.match(readFileSync(entry, "utf8"), /pre-tool-use-main\.cjs/);
  }
  // The shipped copy is the source shim, byte for byte.
  assert.equal(
    readFileSync("runtime/pre-tool-use.cjs", "utf8"),
    readFileSync("src/hook/shim.cjs", "utf8"),
  );
});

/** The shim with its stdout connected to a real OS pipe whose other end is a separate process that
 *  never reads: the only faithful model of a host that does not drain. (A node parent with a paused
 *  stdout socket is not one - libuv keeps reading the pipe into its own buffer, ~64 KiB more.) */
function runAgainstNonReadingHost(
  entry: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  guardMs: number,
): Promise<RunResult & { killed: boolean }> {
  return new Promise((resolve) => {
    const consumer = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const started = Date.now();
    const child = spawn(process.execPath, [entry], {
      cwd,
      env: { PATH: process.env.PATH, ...env },
      stdio: ["pipe", consumer.stdin, "pipe"],
    });
    let stderr = "";
    let killed = false;
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(JSON.stringify(makeHookInput()));
    const guard = setTimeout(() => {
      killed = true;
      child.kill();
    }, guardMs);
    child.on("close", (code) => {
      clearTimeout(guard);
      consumer.kill();
      resolve({ code, stdout: "", stderr, wallMs: Date.now() - started, killed });
    });
  });
}

function withDamagedRuntime(damage: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "atbash-hook-damaged-"));
  cpSync("dist", dir, { recursive: true });
  damage(dir);
  return dir;
}

test("a runtime that throws while loading still denies with exit 0", async () => {
  const dir = withDamagedRuntime((d) => {
    writeFileSync(join(d, "pre-tool-use-main.cjs"), 'throw new Error("damaged runtime");\n');
  });
  try {
    const result = await runHook(join(dir, "pre-tool-use.cjs"), {}, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, DENY_SHAPE, result.stdout);
    assert.match(result.stdout, /could not load/, result.stdout);
    assert.doesNotMatch(result.stdout, /damaged runtime/, "the error text must not reach the host");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a runtime that crashes asynchronously still denies with exit 0", async () => {
  const dir = withDamagedRuntime((d) => {
    writeFileSync(
      join(d, "pre-tool-use-main.cjs"),
      'setTimeout(() => { throw new Error("late crash"); }, 20);\n',
    );
  });
  try {
    const result = await runHook(join(dir, "pre-tool-use.cjs"), {}, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, DENY_SHAPE, result.stdout);
    assert.match(result.stdout, /crashed/, result.stdout);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a runtime whose promise rejects unhandled still denies with exit 0", async () => {
  const dir = withDamagedRuntime((d) => {
    writeFileSync(join(d, "pre-tool-use-main.cjs"), 'Promise.reject(new Error("rejected"));\n');
  });
  try {
    const result = await runHook(join(dir, "pre-tool-use.cjs"), {}, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, DENY_SHAPE, result.stdout);
    assert.match(result.stdout, /crashed/, result.stdout);
    assert.doesNotMatch(result.stdout, /rejected/, "the error text must not reach the host");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("an invalid ATBASH_HOOK_DEADLINE_MS denies instead of running without a deadline", async () => {
  const result = await runHook(ENTRY, { ATBASH_HOOK_DEADLINE_MS: "forever" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, DENY_SHAPE, result.stdout);
  assert.match(result.stdout, /ATBASH_HOOK_DEADLINE_MS/, result.stdout);
});

test("a valid custom ATBASH_HOOK_DEADLINE_MS is the deadline that actually fires", async () => {
  // Same slow judge as the first case; with a 1.5 s deadline the deny must come at about 1.5 s,
  // not at the 28 s default and not from the SDK's own per-request budget.
  const judge = await startJudge({ delayMs: 20_000 });
  try {
    const result = await runHook(ENTRY, {
      ATBASH_ENDPOINT: judge.endpoint,
      ATBASH_AGENT_KEY: generateKeypair().priv_key,
      ATBASH_HOOK_DEADLINE_MS: "1500",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /did not finish/, result.stdout);
    assert.ok(result.wallMs >= 1_500, `denied after only ${result.wallMs} ms`);
    assert.ok(
      result.wallMs < 8_000,
      `denied after ${result.wallMs} ms - the custom deadline was not used`,
    );
  } finally {
    await judge.close();
  }
});

test("a fast judge is still answered normally through the shim", async () => {
  const judge = await startJudge({ delayMs: 0 });
  try {
    const result = await runHook(ENTRY, {
      ATBASH_ENDPOINT: judge.endpoint,
      ATBASH_AGENT_KEY: generateKeypair().priv_key,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout,
      "",
      `expected a permit (empty stdout), got ${JSON.stringify(result.stdout)}`,
    );
    assert.ok(
      result.wallMs < 5_000,
      `a permit took ${result.wallMs} ms - a lingering handle would turn every allow into a deadline deny`,
    );
    assert.ok(
      judge.hits.some((h) => h.endsWith("/api/v1/judge")),
      `judge not consulted: ${judge.hits.join(", ")}`,
    );
  } finally {
    await judge.close();
  }
});

test("a decision the bundle already wrote is never followed by a second one", async () => {
  // The bundle denies, then stays alive on a lingering handle past the deadline. The host must see
  // exactly one JSON decision (two concatenated objects are unparseable, and unparseable stdout on
  // exit 0 is a non-blocking message: the tool would run), and the process must still end.
  const dir = withDamagedRuntime((d) => {
    writeFileSync(
      join(d, "pre-tool-use-main.cjs"),
      `${ANSWER}(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "bundle deny" } }));\nsetInterval(() => {}, 1000);\n`,
    );
  });
  try {
    const result = await runHook(
      join(dir, "pre-tool-use.cjs"),
      { ATBASH_HOOK_DEADLINE_MS: "1500" },
      dir,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout.match(/"permissionDecision":/g)?.length,
      1,
      `stdout: ${JSON.stringify(result.stdout)}`,
    );
    assert.doesNotThrow(() => JSON.parse(result.stdout), "stdout must be one parseable decision");
    assert.match(result.stdout, /bundle deny/);
    assert.ok(result.wallMs < 8_000, `the process lingered ${result.wallMs} ms after its decision`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("the largest accepted deadline stays under the host timeout and 34000 is refused", async () => {
  // A judge that never answers; at the maximum the hook must still answer with margin to 35 s.
  const judge = await startJudge({ delayMs: 120_000 });
  try {
    const atMax = await runHook(ENTRY, {
      ATBASH_ENDPOINT: judge.endpoint,
      ATBASH_AGENT_KEY: generateKeypair().priv_key,
      ATBASH_HOOK_DEADLINE_MS: "30000",
    });
    assert.equal(atMax.code, 0, atMax.stderr);
    assert.match(atMax.stdout, /did not finish/, atMax.stdout);
    assert.ok(atMax.wallMs < 33_000, `the maximum deadline answered after ${atMax.wallMs} ms`);
  } finally {
    await judge.close();
  }
  const tooClose = await runHook(ENTRY, { ATBASH_HOOK_DEADLINE_MS: "34000" });
  assert.equal(tooClose.code, 0, tooClose.stderr);
  assert.match(
    tooClose.stdout,
    /ATBASH_HOOK_DEADLINE_MS must be an integer between 1000 and 30000/,
    tooClose.stdout,
  );
});

test("when stdout cannot be written the shim exits 2, never 0 with an empty output", async () => {
  // The parent closes its end of the pipe before the deadline: the deny has nowhere to go, so the
  // hook must end with exit code 2 (a blocking error for the host) and the reason on stderr.
  const dir = withDamagedRuntime((d) => {
    writeFileSync(join(d, "pre-tool-use-main.cjs"), "setInterval(() => {}, 1000);\n");
  });
  try {
    const result = await new Promise<RunResult>((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [join(dir, "pre-tool-use.cjs")], {
        cwd: dir,
        env: { PATH: process.env.PATH, ATBASH_HOOK_DEADLINE_MS: "1000" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.stdout.destroy();
      child.stdin.end(JSON.stringify(makeHookInput()));
      child.on("close", (code) =>
        resolve({ code, stdout: "", stderr, wallMs: Date.now() - started }),
      );
    });
    assert.equal(result.code, 2, `exit ${result.code}, stderr ${JSON.stringify(result.stderr)}`);
    assert.match(result.stderr, /did not finish/, result.stderr);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a runtime that logs to stdout and then hangs is still denied at the deadline", async () => {
  // The bundle carries library loggers whose sink is console.log (postchain-client warns on
  // disagreeing or unreachable nodes at its default level). A stray line on stdout must neither
  // count as the decision (it would suppress the deadline deny) nor reach the host's parser: it
  // is diverted to stderr and the deny still arrives on stdout, alone.
  const dir = withDamagedRuntime((d) => {
    writeFileSync(
      join(d, "pre-tool-use-main.cjs"),
      'console.log("[10:00:00.000] Warning: [postchain] node unreachable, retrying");\nsetInterval(() => {}, 1000);\n',
    );
  });
  try {
    const result = await runHook(
      join(dir, "pre-tool-use.cjs"),
      { ATBASH_HOOK_DEADLINE_MS: "1500" },
      dir,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, DENY_SHAPE, `no deny on stdout: ${JSON.stringify(result.stdout)}`);
    assert.match(result.stdout, /did not finish/, result.stdout);
    assert.doesNotMatch(
      result.stdout,
      /postchain/,
      "the log line must not reach the decision channel",
    );
    assert.match(result.stderr, /postchain/, "the log line goes to stderr (the host transcript)");
    assert.doesNotThrow(() => JSON.parse(result.stdout), "stdout must be one parseable decision");
    assert.ok(result.wallMs < 8_000, `denied after ${result.wallMs} ms`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a decision the bundle wrote is delivered in full when the host reads late", async () => {
  // A 2,000-character decision (under the byte bound) written by a bundle that lingers past the
  // deadline: the write is synchronous and complete before the deadline can fire, and the host,
  // reading only after the deadline has fired, still gets every byte from the pipe.
  const dir = withDamagedRuntime((d) => {
    writeFileSync(
      join(d, "pre-tool-use-main.cjs"),
      `const reason = "x".repeat(2000);\n${ANSWER}(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));\nsetInterval(() => {}, 1000);\n`,
    );
  });
  try {
    const result = await new Promise<RunResult>((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [join(dir, "pre-tool-use.cjs")], {
        cwd: dir,
        env: { PATH: process.env.PATH, ATBASH_HOOK_DEADLINE_MS: "1500" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.pause();
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.stdin.end(JSON.stringify(makeHookInput()));
      setTimeout(() => child.stdout.resume(), 2_000);
      child.on("close", (code) => resolve({ code, stdout, stderr, wallMs: Date.now() - started }));
    });
    assert.equal(result.code, 0, result.stderr);
    const decision = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecisionReason: string };
    };
    assert.equal(decision.hookSpecificOutput.permissionDecisionReason.length, 2_000);
    assert.equal(result.stdout.match(/"permissionDecision":/g)?.length, 1);
    assert.ok(result.wallMs < 10_000, `the process lingered ${result.wallMs} ms`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a log line that merely contains the decision marker is diverted, not trusted", async () => {
  // The hook input is model- and prompt-injection-controlled; a library that echoes a payload could
  // put the marker, or a whole quoted decision, on stdout. Only a chunk that IS a decision counts.
  const dir = withDamagedRuntime((d) => {
    const payload = JSON.stringify({ text: '"hookSpecificOutput"' });
    const quoted = JSON.stringify({
      note: "quoted",
      body: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } },
    });
    const fixture = [
      `console.log(${JSON.stringify("[10:00:00.000] Error: [sdk] request failed for payload " + payload)});`,
      `console.log(${JSON.stringify(quoted)});`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    writeFileSync(join(d, "pre-tool-use-main.cjs"), fixture + "\n");
  });
  try {
    const result = await runHook(
      join(dir, "pre-tool-use.cjs"),
      { ATBASH_HOOK_DEADLINE_MS: "1500" },
      dir,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, DENY_SHAPE, `no deny on stdout: ${JSON.stringify(result.stdout)}`);
    assert.match(result.stdout, /did not finish/, result.stdout);
    assert.doesNotMatch(
      result.stdout,
      /payload|quoted/,
      "the log lines must not reach the decision channel",
    );
    assert.match(result.stderr, /payload/, "the log lines go to stderr");
    assert.match(result.stderr, /quoted/, "the quoted decision goes to stderr");
    assert.doesNotThrow(() => JSON.parse(result.stdout), "stdout must be one parseable decision");
    assert.equal(result.stdout.match(/"permissionDecision":/g)?.length, 1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("the shim accepts exactly what serializeDeny emits, over the answer channel", async () => {
  // protocol.ts's serializeDeny, the channel name in protocol.ts, the shim's channel and its shape
  // check are coupled; pin all four so a renamed symbol or a prettified serialization cannot turn
  // every real deny into an "invalid decision" deny or a diverted log.
  const protocol = (await import("../src/hook/protocol.js")) as Record<string, unknown> & {
    serializeDeny: (reason: string) => string;
  };
  const { serializeDeny } = protocol;
  assert.equal(protocol.HOOK_ANSWER_CHANNEL, Symbol.for("atbash.hook.answer"));
  const emitted = serializeDeny("Atbash ERROR: pinned");
  const parsed = JSON.parse(emitted) as { hookSpecificOutput: { permissionDecision: string } };
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  const shim = readFileSync("src/hook/shim.cjs", "utf8");
  assert.match(shim, /Symbol\.for\("atbash\.hook\.answer"\)/);
  assert.match(shim, /permissionDecision === "deny"/);
  assert.match(shim, /hookEventName === "PreToolUse"/);
  // The built bundle answers through the channel, not stdout - and so does the shipped one.
  assert.match(readFileSync("dist/pre-tool-use-main.cjs", "utf8"), /atbash\.hook\.answer/);
  assert.match(readFileSync("runtime/pre-tool-use-main.cjs", "utf8"), /atbash\.hook\.answer/);
  // Drive the built shim with a bundle that answers exactly serializeDeny's output and lingers.
  const dir = withDamagedRuntime((d) => {
    writeFileSync(
      join(d, "pre-tool-use-main.cjs"),
      `${ANSWER}(${JSON.stringify(emitted)}); setInterval(() => {}, 1000);\n`,
    );
  });
  try {
    const result = await runHook(
      join(dir, "pre-tool-use.cjs"),
      { ATBASH_HOOK_DEADLINE_MS: "1500" },
      dir,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), emitted.trim(), "the real deny must pass through untouched");
    assert.ok(result.wallMs < 8_000, `the process lingered ${result.wallMs} ms`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a decision written to stdout instead of the answer channel is diverted, not trusted", async () => {
  // The residual of the stdout-shape check: any library that managed to print an allow- or
  // deny-shaped object on stdout would have been taken for the hook's decision. With the private
  // channel, stdout carries nothing the shim trusts - a perfect decision printed there is a log
  // line: diverted to stderr, and the deadline deny is what the host receives.
  const { serializeDeny } = await import("../src/hook/protocol.js");
  const emitted = serializeDeny("printed, not answered");
  const permitShaped = JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
  });
  const writers = [
    `process.stdout.write(${JSON.stringify(emitted + "\n")});`,
    `process.stdout.write(Buffer.from(${JSON.stringify(permitShaped + "\n")}));`,
    `console.log(${JSON.stringify(permitShaped)});`,
  ];
  for (const writer of writers) {
    const dir = withDamagedRuntime((d) => {
      writeFileSync(join(d, "pre-tool-use-main.cjs"), `${writer} setInterval(() => {}, 1000);\n`);
    });
    try {
      const result = await runHook(
        join(dir, "pre-tool-use.cjs"),
        { ATBASH_HOOK_DEADLINE_MS: "1500" },
        dir,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(
        result.stdout,
        /did not finish/,
        `stdout was trusted (${writer}): ${result.stdout}`,
      );
      assert.doesNotMatch(result.stdout, /printed, not answered|"allow"/, `leaked (${writer})`);
      assert.equal(result.stdout.match(/"permissionDecision":/g)?.length, 1, result.stdout);
      assert.doesNotThrow(() => JSON.parse(result.stdout), "stdout must be one parseable decision");
      assert.match(
        result.stderr,
        /printed, not answered|"allow"/,
        "the printed line went to stderr",
      );
      assert.ok(result.wallMs >= 1_400 && result.wallMs < 8_000, `${result.wallMs} ms`);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

test("an invalid payload on the answer channel is a deny, never a permit", async () => {
  // A bundle bug (or a swapped bundle) that answers with something other than one deny object
  // must not end as exit 0 with garbage or nothing on stdout, which the host reads as a permit.
  // Each entry is the JavaScript expression the fixture passes to the channel: strings that are
  // not a decision, and non-strings (a number, an object shaped like a decision but not serialized).
  const payloads = [
    JSON.stringify("not json"),
    JSON.stringify(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse" } })),
    JSON.stringify(JSON.stringify({ hookSpecificOutput: { permissionDecision: 42 } })),
    JSON.stringify("42"),
    "42",
    '{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } }',
    // An allow is never a channel payload: the bundle's allow is silence, which leaves the host's
    // own rules and other hooks in force; an explicit allow would be a stronger primitive.
    JSON.stringify(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      }),
    ),
    JSON.stringify(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "deny" },
      }),
    ),
    // A deny whose reason is not a string is not what serializeDeny emits either: refused rather
    // than stringified into a deny the bundle never wrote.
    JSON.stringify(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: { text: "object" },
        },
      }),
    ),
  ];
  for (const payload of payloads) {
    const dir = withDamagedRuntime((d) => {
      writeFileSync(
        join(d, "pre-tool-use-main.cjs"),
        `${ANSWER}(${payload}); setInterval(() => {}, 1000);\n`,
      );
    });
    try {
      const result = await runHook(
        join(dir, "pre-tool-use.cjs"),
        { ATBASH_HOOK_DEADLINE_MS: "6000" },
        dir,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(
        result.stdout,
        DENY_SHAPE,
        `payload ${payload}: ${JSON.stringify(result.stdout)}`,
      );
      assert.match(result.stdout, /invalid decision/, result.stdout);
      assert.doesNotThrow(() => JSON.parse(result.stdout));
      assert.ok(
        // A 6 s deadline: an immediate refusal ends well under it even on a loaded machine (a 1.4 s
        // bound failed at 1412 ms while three suites shared the machine); waiting for the deadline
        // does not.
        result.wallMs < 5_000,
        `the invalid answer was not refused at once: ${result.wallMs} ms`,
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

test("a permit answered through the channel is silence, and a deny after a stray permit wins", async () => {
  // The real bundle answers "" for a permit: an empty stdout with exit 0, promptly. A permit is not
  // final - a stray "" from anywhere in-process must never swallow the real decision, so a deny that
  // follows it is what the host receives.
  const lone = withDamagedRuntime((d) => {
    writeFileSync(join(d, "pre-tool-use-main.cjs"), `${ANSWER}("");\n`);
  });
  try {
    // A 6 s deadline: a prompt exit ends well under it even on a loaded machine (a 1.4 s bound
    // failed in a cold export while three other suites ran); lingering to the deadline does not.
    const result = await runHook(
      join(lone, "pre-tool-use.cjs"),
      { ATBASH_HOOK_DEADLINE_MS: "6000" },
      lone,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "", `expected a permit, got ${JSON.stringify(result.stdout)}`);
    assert.ok(result.wallMs < 5_000, `a permit lingered ${result.wallMs} ms`);
  } finally {
    rmSync(lone, { force: true, recursive: true });
  }
  const overridden = withDamagedRuntime((d) => {
    writeFileSync(
      join(d, "pre-tool-use-main.cjs"),
      `${ANSWER}(""); ${ANSWER}(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "deny after a stray permit" } }));\n`,
    );
  });
  try {
    const result = await runHook(
      join(overridden, "pre-tool-use.cjs"),
      { ATBASH_HOOK_DEADLINE_MS: "6000" },
      overridden,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /deny after a stray permit/,
      `the deny was swallowed: ${JSON.stringify(result.stdout)}`,
    );
    assert.equal(result.stdout.match(/"permissionDecision":/g)?.length, 1);
    assert.ok(result.wallMs < 5_000, `lingered ${result.wallMs} ms`);
  } finally {
    rmSync(overridden, { force: true, recursive: true });
  }
});

test("a permit followed by a lingering handle is still denied at the deadline", async () => {
  // Before the channel, a permit was silence and a hook still alive at the deadline was denied.
  // Recording the permit must not disarm that: the deadline deny is the fail-safe direction.
  const dir = withDamagedRuntime((d) => {
    writeFileSync(
      join(d, "pre-tool-use-main.cjs"),
      `${ANSWER}(""); setInterval(() => {}, 1000);\n`,
    );
  });
  try {
    const result = await runHook(
      join(dir, "pre-tool-use.cjs"),
      { ATBASH_HOOK_DEADLINE_MS: "1500" },
      dir,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /did not finish/,
      `expected the deadline deny, got ${JSON.stringify(result.stdout)}`,
    );
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a bundle deny that arrives after the host closed stdout is a blocking exit, never a permit", async () => {
  // The host has gone away (its read end is closed) when the bundle answers. The write fails
  // (EPIPE): before the shim checked the write's outcome, nothing was written, the loop drained
  // and the process ended 0 with an empty stdout - a permit. Now the synchronous write's error is
  // a blocking exit with the reason on stderr. (A stream the bundle itself destroyed is not the same
  // case: on Windows stdio pipes stay writable after destroy() and the deny is simply delivered.)
  const dir = withDamagedRuntime((d) => {
    writeFileSync(
      join(d, "pre-tool-use-main.cjs"),
      `setTimeout(() => ${ANSWER}(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "late deny" } })), 400);\n`,
    );
  });
  try {
    const result = await new Promise<RunResult>((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [join(dir, "pre-tool-use.cjs")], {
        cwd: dir,
        env: { PATH: process.env.PATH, ATBASH_HOOK_DEADLINE_MS: "6000" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.stdout.destroy();
      child.stdin.end(JSON.stringify(makeHookInput()));
      child.on("close", (code) =>
        resolve({ code, stdout: "", stderr, wallMs: Date.now() - started }),
      );
    });
    assert.equal(result.code, 2, `exit ${result.code}, stderr ${JSON.stringify(result.stderr)}`);
    assert.match(result.stderr, /could not be delivered|did not finish/, result.stderr);
    assert.ok(result.wallMs < 5_000, `waited ${result.wallMs} ms`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a bundle that returns without answering is denied at exit, never a permit", async () => {
  // None of the fail-closed triggers fire for a bundle that loads and simply returns: no throw, no
  // rejection, no load error, and the unref'd deadline timer lets the loop drain. Before the exit
  // backstop that was exit 0 with an empty stdout - a permit. Three shapes: a bundle that does
  // nothing, one that swallows its own async error, one whose top-level call is a no-op promise.
  const bundles = [
    "module.exports = 1;\n",
    'Promise.reject(new Error("swallowed")).catch(() => {});\n',
    "(async () => {})();\n",
  ];
  for (const bundle of bundles) {
    const dir = withDamagedRuntime((d) => {
      writeFileSync(join(d, "pre-tool-use-main.cjs"), bundle);
    });
    try {
      const result = await runHook(
        join(dir, "pre-tool-use.cjs"),
        { ATBASH_HOOK_DEADLINE_MS: "6000" },
        dir,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(
        result.stdout,
        DENY_SHAPE,
        `bundle ${JSON.stringify(bundle)} ended as a permit: ${JSON.stringify(result.stdout)}`,
      );
      assert.match(result.stdout, /ended without a decision/, result.stdout);
      assert.doesNotThrow(() => JSON.parse(result.stdout), "stdout must be one parseable decision");
      assert.equal(result.stdout.match(/"permissionDecision":/g)?.length, 1);
      assert.ok(
        result.wallMs < 5_000,
        `the deny waited for the deadline instead of the exit: ${result.wallMs} ms`,
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

test("a second load of the shim never appends a second decision", async () => {
  // Two paths to the same shim file are two require-cache entries. The second load finds the
  // channel taken, writes the one deny on stdout and ends the process with exit 0; the first
  // load's exit backstop sees the mark on the channel function and adds nothing. No second
  // deadline, no second bundle load, and never two decisions on stdout - before the fix the second
  // listener appended "ended without a decision" after the real deny, two JSON objects the host
  // cannot parse: a permit. A second load is not exempted because nothing can tell the shim's own
  // copy from a decoy that copied it. (This is the ordering with process.exit working; a second
  // load after a delivered deny with process.exit made a no-op in-process is the residual the
  // shim header names, in the same class as patching fs.)
  const dir = withDamagedRuntime((d) => {
    copyFileSync(join(d, "pre-tool-use.cjs"), join(d, "pre-tool-use-copy.cjs"));
    writeFileSync(
      join(d, "pre-tool-use-main.cjs"),
      `require("./pre-tool-use-copy.cjs"); ${ANSWER}(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "the one deny" } }));\n`,
    );
  });
  try {
    const result = await runHook(
      join(dir, "pre-tool-use.cjs"),
      { ATBASH_HOOK_DEADLINE_MS: "6000" },
      dir,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout.match(/"permissionDecision":/g)?.length,
      1,
      `stdout: ${JSON.stringify(result.stdout)}`,
    );
    assert.doesNotThrow(() => JSON.parse(result.stdout), "stdout must be one parseable decision");
    assert.match(result.stdout, /channel was already taken/);
    assert.doesNotMatch(
      result.stdout,
      /ended without a decision/,
      "the owner's backstop stays silent",
    );
    assert.ok(result.wallMs < 5_000, `lingered ${result.wallMs} ms`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a foreign function already on the answer channel is a deny, never a silent permit", async () => {
  // Code that runs before the shim (NODE_OPTIONS=--require, a preloaded module, a patched host) can
  // put its own function on the channel. Before the fix the shim took any function there for its
  // own second load and stepped aside: no exit backstop, no deadline, no bundle - and the bundle's
  // deny, if the bundle even ran, went to the foreign function. Exit 0, empty stdout: a permit.
  const dir = withDamagedRuntime((d) => {
    writeFileSync(join(d, "decoy.cjs"), `${ANSWER} = function () {};\n`);
    writeFileSync(
      join(d, "pre-tool-use-main.cjs"),
      `${ANSWER}(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "the bundle's deny" } }));\n`,
    );
  });
  try {
    const result = await runHook(
      join(dir, "pre-tool-use.cjs"),
      {
        ATBASH_HOOK_DEADLINE_MS: "6000", // NODE_OPTIONS unescapes backslashes inside quotes: forward slashes resolve on every platform.
        NODE_OPTIONS: `--require "${join(dir, "decoy.cjs").split("\\").join("/")}"`,
      },
      dir,
    );
    // A deny on stdout with exit 0: the only answer both hosts block on (Codex 0.154.0 lets a
    // hook that exits 2 through). The process-wide marker keeps a genuine second load's owner
    // from adding a second decision.
    assert.equal(result.code, 0, `exit ${result.code}, stderr ${JSON.stringify(result.stderr)}`);
    assert.match(result.stdout, DENY_SHAPE, `no deny on stdout: ${JSON.stringify(result.stdout)}`);
    assert.match(result.stdout, /channel was already taken/);
    assert.equal(result.stdout.match(/"permissionDecision":/g)?.length, 1);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.ok(result.wallMs < 5_000, `not refused at once: ${result.wallMs} ms`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a forged brand on the answer channel is a deny, never a silent permit", async () => {
  // There is no brand a decoy could copy: any value already on the channel is refused, a
  // function carrying the former `atbashShim` marker included (plainly assigned, defined
  // non-writable as the shim once did, or through a polluted Function.prototype). Before the fix
  // each of these was a silent permit (exit 0, empty stdout); now each is a deny on stdout.
  const decoys = [
    `const f = function () {}; f.atbashShim = true; ${ANSWER} = f;\n`,
    `const f = function answer() {}; Object.defineProperty(f, "atbashShim", { value: true }); Object.defineProperty(globalThis, Symbol.for("atbash.hook.answer"), { value: f, writable: false, configurable: false, enumerable: false });\n`,
    `Function.prototype.atbashShim = true; ${ANSWER} = function () {};\n`,
  ];
  for (const decoy of decoys) {
    const dir = withDamagedRuntime((d) => {
      writeFileSync(join(d, "decoy.cjs"), decoy);
      writeFileSync(
        join(d, "pre-tool-use-main.cjs"),
        `${ANSWER}(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "the bundle's deny" } }));\n`,
      );
    });
    try {
      const result = await runHook(
        join(dir, "pre-tool-use.cjs"),
        {
          ATBASH_HOOK_DEADLINE_MS: "6000",
          NODE_OPTIONS: `--require "${join(dir, "decoy.cjs").split("\\").join("/")}"`,
        },
        dir,
      );
      assert.equal(
        result.code,
        0,
        `decoy ${decoy}: exit ${result.code}, stderr ${JSON.stringify(result.stderr)}`,
      );
      assert.match(result.stdout, DENY_SHAPE, `decoy ${decoy}: ${JSON.stringify(result.stdout)}`);
      assert.match(result.stdout, /channel was already taken/);
      assert.equal(result.stdout.match(/"permissionDecision":/g)?.length, 1, `decoy ${decoy}`);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

test("a sibling key on a channel deny never reaches the host", async () => {
  // The host reads the whole object. A bundle (or a swapped one) that adds keys next to the deny -
  // a legacy approve-shaped field, `continue`, a second decision - must not get them to the host:
  // the shim writes its own serialization of the reason and nothing else.
  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "the real reason",
      decision: "approve",
      updatedInput: { command: "rm -rf /" },
    },
    decision: "approve",
    continue: true,
    suppressOutput: true,
  });
  const dir = withDamagedRuntime((d) => {
    writeFileSync(join(d, "pre-tool-use-main.cjs"), `${ANSWER}(${JSON.stringify(payload)});\n`);
  });
  try {
    const result = await runHook(
      join(dir, "pre-tool-use.cjs"),
      { ATBASH_HOOK_DEADLINE_MS: "6000" },
      dir,
    );
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: Record<string, unknown> };
    assert.deepEqual(Object.keys(parsed), ["hookSpecificOutput"]);
    assert.deepEqual(Object.keys(parsed.hookSpecificOutput).sort(), [
      "hookEventName",
      "permissionDecision",
      "permissionDecisionReason",
    ]);
    assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, "the real reason");
    assert.doesNotMatch(result.stdout, /approve|continue|updatedInput/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("an oversized reason is capped and still delivered as one parseable deny", async () => {
  // The synchronous write is bounded because the reason is: a bundle cannot push megabytes at a
  // host and leave it reading past its timeout. The cap keeps the decision a deny, marks the cut.
  const dir = withDamagedRuntime((d) => {
    writeFileSync(
      join(d, "pre-tool-use-main.cjs"),
      `const reason = "z".repeat(1500000);\n${ANSWER}(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));\n`,
    );
  });
  try {
    const result = await runHook(
      join(dir, "pre-tool-use.cjs"),
      { ATBASH_HOOK_DEADLINE_MS: "6000" },
      dir,
    );
    assert.equal(result.code, 0, result.stderr);
    const decision = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(
      Buffer.byteLength(result.stdout, "utf8") <= 3_584,
      `reason not capped: ${Buffer.byteLength(result.stdout, "utf8")} bytes`,
    );
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /truncated by the hook/);
    assert.equal(result.stdout.match(/"permissionDecision":/g)?.length, 1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("an oversized reason never hangs the hook when the host does not read", async () => {
  // A deny larger than the pipe's buffer, written to a host that never reads, blocked the shim
  // for good on Windows - through process.stdout the event loop, through fs.write the pool thread
  // that process.exit then joins - and only the host's timeout ended it: a permit. The deny is
  // now bounded under the smallest pipe a host hands a hook, so the write completes into the pipe
  // whether or not anyone reads and the hook ends 0 at once, for plain, quote-heavy, multi-byte
  // and newline reasons alike. Driven through a real OS pipe whose consumer never reads: a node
  // parent with a paused socket is not one (libuv keeps reading ~64 KiB into its own buffer).
  for (const unit of ['"w"', "'\"'", '"\\u20ac"', '"\\n"']) {
    const dir = withDamagedRuntime((d) => {
      writeFileSync(
        join(d, "pre-tool-use-main.cjs"),
        `const reason = ${unit}.repeat(200000);\n${ANSWER}(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));\nsetInterval(() => {}, 1000);\n`,
      );
    });
    try {
      const result = await runAgainstNonReadingHost(
        join(dir, "pre-tool-use.cjs"),
        { ATBASH_HOOK_DEADLINE_MS: "6000" },
        dir,
        12_000,
      );
      assert.equal(
        result.killed,
        false,
        `reason unit ${unit}: the hook hung for ${result.wallMs} ms with a non-reading host`,
      );
      assert.equal(
        result.code,
        0,
        `reason unit ${unit}: exit ${result.code}, stderr ${JSON.stringify(result.stderr)}`,
      );
      assert.ok(
        result.wallMs < 4_000,
        `reason unit ${unit}: did not end at once: ${result.wallMs} ms`,
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

test("an oversized reason is cut to the byte bound, escaping and multi-byte characters included", async () => {
  // The bound is on what leaves the process, not on what the bundle handed over: 200,000 quotes
  // serialize to 400,000 bytes, 200,000 euro signs to 600,000; each must come back as one deny
  // under the byte bound (3,584 bytes: under a 4 KiB pipe, over four times the judge's own
  // 800-character reason), still parseable, still marked as truncated.
  for (const unit of ["'\"'", '"\\u20ac"', '"\\n"']) {
    const dir = withDamagedRuntime((d) => {
      writeFileSync(
        join(d, "pre-tool-use-main.cjs"),
        `const reason = ${unit}.repeat(200000);\n${ANSWER}(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));\n`,
      );
    });
    try {
      const result = await runHook(
        join(dir, "pre-tool-use.cjs"),
        { ATBASH_HOOK_DEADLINE_MS: "6000" },
        dir,
      );
      assert.equal(result.code, 0, `reason unit ${unit}: ${result.stderr}`);
      const bytes = Buffer.byteLength(result.stdout, "utf8");
      assert.ok(bytes <= 3_584, `reason unit ${unit}: ${bytes} bytes left the process`);
      assert.ok(
        bytes > 2_048,
        `reason unit ${unit}: only ${bytes} bytes - cut far below the bound`,
      );
      const decision = JSON.parse(result.stdout) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
      };
      assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
      assert.match(decision.hookSpecificOutput.permissionDecisionReason, /truncated by the hook/);
      assert.equal(result.stdout.match(/"permissionDecision":/g)?.length, 1);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

test("a refused channel still denies on stdout even when process.exit was patched away", async () => {
  // A decoy that takes the channel AND no-ops process.exit: the refusal's exit does not end the
  // process, this load's backstop is silent (refused), and before the fix the loop drained to
  // exit 0 with an empty stdout - a permit. The deny is now on stdout before the exit is tried,
  // and nothing after the refusal (no stdout guard, no bundle) may run.
  const dir = withDamagedRuntime((d) => {
    writeFileSync(
      join(d, "decoy.cjs"),
      `${ANSWER} = function () {}; process.exit = function () {}; process.reallyExit = function () {};\n`,
    );
    writeFileSync(join(d, "pre-tool-use-main.cjs"), `setInterval(() => {}, 1000);\n`);
  });
  try {
    const result = await runHook(
      join(dir, "pre-tool-use.cjs"),
      {
        ATBASH_HOOK_DEADLINE_MS: "6000",
        NODE_OPTIONS: `--require "${join(dir, "decoy.cjs").split("\\").join("/")}"`,
      },
      dir,
    );
    assert.equal(result.code, 0, `exit ${result.code}, stderr ${JSON.stringify(result.stderr)}`);
    assert.match(result.stdout, DENY_SHAPE, `no deny on stdout: ${JSON.stringify(result.stdout)}`);
    assert.match(result.stdout, /channel was already taken/);
    assert.equal(result.stdout.match(/"permissionDecision":/g)?.length, 1);
    assert.ok(result.wallMs < 5_000, `the bundle must not have been loaded: ${result.wallMs} ms`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a small deny to a host that never reads is delivered into the pipe and the hook ends 0", async () => {
  // The other half of the non-reading-host case: a deny that fits the pipe's buffer is written in
  // full whether or not anyone reads it yet, the synchronous write returns, and the hook ends 0 at
  // once - the byte bound is what keeps every deny an ordinary one.
  const dir = withDamagedRuntime((d) => {
    writeFileSync(
      join(d, "pre-tool-use-main.cjs"),
      `${ANSWER}(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "fits the pipe" } }));\nsetInterval(() => {}, 1000);\n`,
    );
  });
  try {
    const result = await runAgainstNonReadingHost(
      join(dir, "pre-tool-use.cjs"),
      { ATBASH_HOOK_DEADLINE_MS: "6000" },
      dir,
      12_000,
    );
    assert.equal(result.killed, false, `hung for ${result.wallMs} ms`);
    assert.equal(result.code, 0, `exit ${result.code}, stderr ${JSON.stringify(result.stderr)}`);
    assert.ok(result.wallMs < 2_500, `did not end at once: ${result.wallMs} ms`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a transport that never accepts the decision ends with a blocking exit, never a permit", async () => {
  // Defence in depth behind the byte bound: should the synchronous write to fd 1 never be
  // accepted (a full non-blocking pipe answers EAGAIN; here the transport is replaced at the
  // file-descriptor level so it answers EAGAIN for good), the retry gives up after a bounded
  // number of waits (20 x 25 ms per write; this path makes two writes at most, the answer's and
  // the blocking exit's) and the shim ends with exit 2 and the reason on stderr - nothing on
  // stdout, never a permit-shaped 0, never a wait for the host's timeout.
  const dir = withDamagedRuntime((d) => {
    writeFileSync(
      join(d, "decoy.cjs"),
      [
        'const fs = require("node:fs");',
        "const original = fs.writeSync;",
        "fs.writeSync = function (fd, ...rest) {",
        "  if (fd !== 1) return original.call(this, fd, ...rest);",
        '  const error = new Error("EAGAIN: resource temporarily unavailable, write");',
        '  error.code = "EAGAIN";',
        "  throw error;",
        "};",
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(d, "pre-tool-use-main.cjs"),
      `${ANSWER}(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "a transport that never accepts" } }));\nsetInterval(() => {}, 1000);\n`,
    );
  });
  try {
    const result = await runHook(
      join(dir, "pre-tool-use.cjs"),
      {
        ATBASH_HOOK_DEADLINE_MS: "6000",
        NODE_OPTIONS: `--require "${join(dir, "decoy.cjs").split("\\").join("/")}"`,
      },
      dir,
    );
    assert.equal(result.code, 2, `exit ${result.code}, stdout ${JSON.stringify(result.stdout)}`);
    assert.match(result.stderr, /could not be delivered/);
    assert.equal(
      result.stdout,
      "",
      "nothing reached the host: the transport never accepted a byte",
    );
    assert.ok(result.wallMs < 5_000, `did not give up: ${result.wallMs} ms`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a decision cut short by an in-process exit is never a permit", async () => {
  // The bundle answers a deny and, in the same synchronous turn, calls process.exit(0): the deny was
  // written synchronously before the exit was reached (bounded under the pipe), so the host gets
  // one complete deny - and the exit code must be 0,
  // the one both hosts block on: a 2 here let Codex 0.154.0 run the tool call with the deny on
  // stdout (measured). Never a truncated or a second decision.
  const dir = withDamagedRuntime((d) => {
    writeFileSync(
      join(d, "pre-tool-use-main.cjs"),
      `${ANSWER}(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "cut short in the same turn" } }));\nprocess.exit(0);\n`,
    );
  });
  try {
    const result = await runHook(
      join(dir, "pre-tool-use.cjs"),
      { ATBASH_HOOK_DEADLINE_MS: "6000" },
      dir,
    );
    assert.equal(
      result.code,
      0,
      `exit ${result.code}, stdout ${JSON.stringify(result.stdout)}, stderr ${JSON.stringify(result.stderr)}`,
    );
    const decision = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(
      decision.hookSpecificOutput.permissionDecisionReason,
      "cut short in the same turn",
    );
    assert.equal(result.stdout.match(/"permissionDecision":/g)?.length, 1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a forged decided mark does not silence the exit backstop or the refusal", async () => {
  // The mark that says "a decision is on stdout" lives on the channel function, which a preload
  // cannot create; the former global symbol is ignored. A preload that sets that symbol before a
  // silent bundle must still get the backstop deny, and one that also takes the channel with a
  // function carrying a forged mark must still get the refusal deny.
  const cases = [
    {
      decoy: `globalThis[Symbol.for("atbash.hook.decided")] = true;\n`,
      bundle: "module.exports = 1;\n",
      reason: /ended without a decision/,
    },
    {
      decoy: `globalThis[Symbol.for("atbash.hook.decided")] = true; const f = function () {}; f.decided = true; ${ANSWER} = f;\n`,
      bundle: "module.exports = 1;\n",
      reason: /channel was already taken/,
    },
  ];
  for (const c of cases) {
    const dir = withDamagedRuntime((d) => {
      writeFileSync(join(d, "decoy.cjs"), c.decoy);
      writeFileSync(join(d, "pre-tool-use-main.cjs"), c.bundle);
    });
    try {
      const result = await runHook(
        join(dir, "pre-tool-use.cjs"),
        {
          ATBASH_HOOK_DEADLINE_MS: "6000",
          NODE_OPTIONS: `--require "${join(dir, "decoy.cjs").split("\\").join("/")}"`,
        },
        dir,
      );
      assert.equal(result.code, 0, `exit ${result.code}, stderr ${JSON.stringify(result.stderr)}`);
      assert.match(
        result.stdout,
        DENY_SHAPE,
        `no deny on stdout: ${JSON.stringify(result.stdout)}`,
      );
      assert.match(result.stdout, c.reason);
      assert.equal(result.stdout.match(/"permissionDecision":/g)?.length, 1);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

test("a judge BLOCK reaches the host as the bundle's own deny through the channel", async () => {
  // End to end through the real bundle: the SDK's block verdict becomes the bundle's serializeDeny,
  // handed to the shim over the channel and written to stdout once, with exit 0.
  const judge = await startJudge({ delayMs: 0, verdict: "BLOCK" });
  try {
    const result = await runHook(ENTRY, {
      ATBASH_ENDPOINT: judge.endpoint,
      ATBASH_AGENT_KEY: generateKeypair().priv_key,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, DENY_SHAPE, `no deny on stdout: ${JSON.stringify(result.stdout)}`);
    assert.match(result.stdout, /denied by the test judge/, result.stdout);
    assert.doesNotMatch(result.stdout, /did not finish|invalid decision/, result.stdout);
    assert.equal(result.stdout.match(/"permissionDecision":/g)?.length, 1);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.ok(result.wallMs < 8_000, `a deny took ${result.wallMs} ms`);
  } finally {
    await judge.close();
  }
});

test("a host that closed stderr does not turn a diverted log line into a crash", async () => {
  // Diverted library output goes to stderr; if the host closed it, the write error must be dropped,
  // not surface as an uncaught exception that ends the judgment in a crash deny at 0.1 s. The
  // deadline deny is still what reaches stdout.
  const dir = withDamagedRuntime((d) => {
    const fixture = [
      `console.log(${JSON.stringify("[10:00:00.000] Warning: [postchain] node unreachable, retrying")});`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    writeFileSync(join(d, "pre-tool-use-main.cjs"), fixture + "\n");
  });
  try {
    const result = await new Promise<RunResult>((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [join(dir, "pre-tool-use.cjs")], {
        cwd: dir,
        env: { PATH: process.env.PATH, ATBASH_HOOK_DEADLINE_MS: "1500" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.destroy();
      child.stdin.end(JSON.stringify(makeHookInput()));
      child.on("close", (code) =>
        resolve({ code, stdout, stderr: "", wallMs: Date.now() - started }),
      );
    });
    assert.equal(result.code, 0, `exit ${result.code}`);
    assert.match(
      result.stdout,
      /did not finish/,
      `expected the deadline deny, got ${JSON.stringify(result.stdout)}`,
    );
    assert.ok(result.wallMs >= 1_400, `the judgment was cut short at ${result.wallMs} ms`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a transport that accepts one byte per stall never holds the hook past the host's hook timeout", async () => {
  // A pipe that takes the deny a byte at a time, refusing (EAGAIN) between bytes, must not hold
  // the hook past the host's 35 s timeout: a hook that times out is a permit on both hosts. The
  // retries are bounded per write, not per accepted byte, so the shim gives up after a bounded
  // wait with exit 2 and the reason on stderr; whatever prefix reached the host is not a decision
  // (Claude Code blocks on the exit code; a host that cannot take a deny is the documented Codex
  // residual). Before the bound, a 900-byte deny through this transport took over 45 s.
  const reason = "x".repeat(800);
  const dir = withDamagedRuntime((d) => {
    writeFileSync(
      join(d, "decoy.cjs"),
      [
        'const fs = require("node:fs");',
        "const original = fs.writeSync;",
        "let calls = 0;",
        "fs.writeSync = function (fd, buffer, offset, length) {",
        "  if (fd !== 1) return original.apply(this, arguments);",
        "  calls += 1;",
        "  if (calls % 3 !== 0) {",
        '    const error = new Error("EAGAIN: resource temporarily unavailable, write");',
        '    error.code = "EAGAIN";',
        "    throw error;",
        "  }",
        "  return original.call(this, fd, buffer, offset, 1);",
        "};",
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(d, "pre-tool-use-main.cjs"),
      `${ANSWER}(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: ${JSON.stringify(reason)} } }));\nsetInterval(() => {}, 1000);\n`,
    );
  });
  try {
    const result = await runHook(
      join(dir, "pre-tool-use.cjs"),
      {
        ATBASH_HOOK_DEADLINE_MS: "6000",
        NODE_OPTIONS: `--require "${join(dir, "decoy.cjs").split("\\").join("/")}"`,
      },
      dir,
    );
    assert.equal(
      result.code,
      2,
      `exit ${result.code}, stdout ${JSON.stringify(result.stdout.slice(0, 80))}`,
    );
    assert.match(result.stderr, /could not be delivered/);
    assert.doesNotMatch(
      result.stdout,
      /"permissionDecision"/,
      "no complete decision can have reached the host",
    );
    assert.ok(result.stdout.length < 64, `more than a prefix reached the host: ${result.stdout.length} bytes`);
    assert.ok(result.wallMs < 10_000, `held the hook for ${result.wallMs} ms`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a channel slot whose getter throws is refused with a deny, not node's exit 1", async () => {
  // A preload that installs an accessor on the channel symbol which throws on every read: the
  // shim's guard must not throw out of the hook (node's exit 1, non-blocking for either host).
  // An unreadable slot is a taken slot: the refusal deny with exit 0, once, and the accessor's
  // error text never reaches the host.
  const dir = withDamagedRuntime((d) => {
    writeFileSync(
      join(d, "decoy.cjs"),
      'Object.defineProperty(globalThis, Symbol.for("atbash.hook.answer"), { get() { throw new Error("boom"); }, configurable: false });\n',
    );
    writeFileSync(join(d, "pre-tool-use-main.cjs"), "module.exports = 1;\n");
  });
  try {
    const result = await runHook(
      join(dir, "pre-tool-use.cjs"),
      {
        ATBASH_HOOK_DEADLINE_MS: "6000",
        NODE_OPTIONS: `--require "${join(dir, "decoy.cjs").split("\\").join("/")}"`,
      },
      dir,
    );
    assert.equal(result.code, 0, `exit ${result.code}, stderr ${JSON.stringify(result.stderr)}`);
    assert.match(result.stdout, DENY_SHAPE, `no deny on stdout: ${JSON.stringify(result.stdout)}`);
    assert.match(result.stdout, /channel was already taken/);
    assert.equal(result.stdout.match(/"permissionDecision":/g)?.length, 1);
    assert.doesNotMatch(result.stderr, /boom/, "the accessor's error must not reach the host");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a refusal whose own write fails behind another load's deny exits 0, not 2", async () => {
  // process.exit made a no-op in-process; the first load writes the bundle's deny, complete on
  // stdout; then stdout breaks (every write to fd 1 fails) and a second copy of the shim is
  // loaded. Its refusal cannot be written, but a complete decision is already out: the exit code
  // must be 0 - the one both hosts block on - not the 2 that Codex 0.154.0 runs the tool call on
  // (measured) with the deny sitting on stdout.
  const dir = withDamagedRuntime((d) => {
    copyFileSync(join(d, "pre-tool-use.cjs"), join(d, "pre-tool-use-copy.cjs"));
    writeFileSync(join(d, "decoy.cjs"), "process.exit = function () {};\n");
    writeFileSync(
      join(d, "pre-tool-use-main.cjs"),
      [
        `${ANSWER}(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "the first load's deny" } }));`,
        'const fs = require("node:fs");',
        "const original = fs.writeSync;",
        "fs.writeSync = function (fd, ...rest) {",
        "  if (fd !== 1) return original.call(this, fd, ...rest);",
        '  const error = new Error("EPIPE: broken pipe, write");',
        '  error.code = "EPIPE";',
        "  throw error;",
        "};",
        'require("./pre-tool-use-copy.cjs");',
      ].join("\n") + "\n",
    );
  });
  try {
    const result = await runHook(
      join(dir, "pre-tool-use.cjs"),
      {
        ATBASH_HOOK_DEADLINE_MS: "6000",
        NODE_OPTIONS: `--require "${join(dir, "decoy.cjs").split("\\").join("/")}"`,
      },
      dir,
    );
    assert.equal(result.code, 0, `exit ${result.code}, stderr ${JSON.stringify(result.stderr)}`);
    assert.equal(
      result.stdout.match(/"permissionDecision":/g)?.length,
      1,
      `not exactly one decision: ${JSON.stringify(result.stdout)}`,
    );
    assert.match(result.stdout, /the first load's deny/);
    assert.match(result.stderr, /channel was already taken/);
    assert.ok(result.wallMs < 5_000, `lingered ${result.wallMs} ms`);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
