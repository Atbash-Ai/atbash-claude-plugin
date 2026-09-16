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
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateKeypair } from "@atbash/sdk";

import { makeHookInput } from "./fixtures.js";

const ENTRY = "dist/pre-tool-use.cjs";
const DENY_SHAPE = /"permissionDecision":"deny"/;

interface JudgeOptions {
  delayMs: number;
}

async function startJudge({ delayMs }: JudgeOptions) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    hits.push(`${req.method} ${url.pathname}`);
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const answer = (body: unknown) => setTimeout(() => res.end(JSON.stringify(body)), delayMs);
      if (url.pathname === "/api/ai/exists") {
        answer({ registered: true, pubkey: url.searchParams.get("pubkey"), org_encryption_pubkey: null });
      } else if (url.pathname === "/api/risk-engine") {
        answer({ policy: "", is_custom: false, default_policy: "default", is_jailed: false });
      } else if (url.pathname === "/api/v1/judge") {
        answer({ verdict: "ALLOW", action_type: "allow", allow: true, reason: "routine", tool_call_id: "tc-1" });
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
    assert.ok(result.wallMs < 34_000, `hook answered after ${result.wallMs} ms, past the host timeout`);
    assert.ok(judge.hits.length >= 1, "the judge was never contacted");
  } finally {
    await judge.close();
  }
});

test("the shipped entry point is a small un-bundled shim in front of the bundled hook", () => {
  // The shim is what makes the next two tests possible: it must not itself be the megabyte bundle
  // whose load failure it guards against.
  const size = statSync(ENTRY).size;
  assert.ok(size < 16_384, `${ENTRY} is ${size} bytes - it should be the shim, not the bundle`);
  assert.match(readFileSync(ENTRY, "utf8"), /pre-tool-use-main\.cjs/);
});

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

test("a fast judge is still answered normally through the shim", async () => {
  const judge = await startJudge({ delayMs: 0 });
  try {
    const result = await runHook(ENTRY, {
      ATBASH_ENDPOINT: judge.endpoint,
      ATBASH_AGENT_KEY: generateKeypair().priv_key,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "", `expected a permit (empty stdout), got ${JSON.stringify(result.stdout)}`);
    assert.ok(judge.hits.some((h) => h.endsWith("/api/v1/judge")), `judge not consulted: ${judge.hits.join(", ")}`);
  } finally {
    await judge.close();
  }
});
