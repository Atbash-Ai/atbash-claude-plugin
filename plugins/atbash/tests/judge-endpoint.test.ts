/**
 * The judge endpoint. The SDK accepts a plain-http loopback endpoint with no response-signing key,
 * so anything that can set ATBASH_ENDPOINT (or `judgeEndpoint` in ~/.config/atbash/config.json) and
 * listen on a local port can answer ALLOW to every call. The hook therefore refuses a loopback or
 * non-https endpoint unless BOTH the developer flag ATBASH_DEV_ALLOW_LOCAL_JUDGE=1 is set in the
 * hook's own environment AND a response-signing key is configured, so every verdict must carry a
 * signature the SDK verifies. These tests run the BUILT hook against a real judge on loopback.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateKeypair } from "@atbash/sdk";

import { makeHookInput } from "./fixtures.js";
import { runBuiltHook, startLocalJudge } from "./local-judge.js";

const DENY_SHAPE = /"permissionDecision":"deny"/;

async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "atbash-endpoint-home-"));
  try {
    return await run(home);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
}

function judged(hits: readonly string[]): boolean {
  return hits.some((hit) => hit.endsWith("/api/v1/judge"));
}

test("a loopback judge without the dev flag and a verify key is refused, even when it answers ALLOW", async () => {
  const judge = await startLocalJudge();
  try {
    await withHome(async (home) => {
      const result = await runBuiltHook(
        makeHookInput(),
        { ...judge.unsafeEnv, ATBASH_AGENT_KEY: generateKeypair().priv_key },
        home,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, DENY_SHAPE, `a fake local judge was trusted: ${result.stdout}`);
      assert.match(result.stdout, /ATBASH_DEV_ALLOW_LOCAL_JUDGE/, result.stdout);
      assert.equal(judged(judge.hits), false, `the judge was consulted: ${judge.hits.join(", ")}`);
    });
  } finally {
    await judge.close();
  }
});

test("a loopback judge needs both the dev flag and a verify key", async () => {
  const judge = await startLocalJudge();
  try {
    for (const env of [
      { ...judge.unsafeEnv, ATBASH_DEV_ALLOW_LOCAL_JUDGE: "1" },
      { ...judge.unsafeEnv, ATBASH_JUDGE_VERIFY_PUBKEY: judge.verifyPubKey },
      { ...judge.env, ATBASH_DEV_ALLOW_LOCAL_JUDGE: "true" },
      {
        ...judge.env,
        ATBASH_ENDPOINT: judge.endpoint.replace("127.0.0.1", "localhost"),
        ATBASH_DEV_ALLOW_LOCAL_JUDGE: "",
      },
    ]) {
      await withHome(async (home) => {
        const result = await runBuiltHook(
          makeHookInput(),
          { ...env, ATBASH_AGENT_KEY: generateKeypair().priv_key },
          home,
        );
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, DENY_SHAPE, `${JSON.stringify(env)}: ${result.stdout}`);
        assert.match(result.stdout, /ATBASH_DEV_ALLOW_LOCAL_JUDGE/, result.stdout);
      });
    }
    assert.equal(judged(judge.hits), false, `the judge was consulted: ${judge.hits.join(", ")}`);
  } finally {
    await judge.close();
  }
});

test("the Atbash config file alone cannot point the hook at a local judge", async () => {
  // The config file is where an agent with file access would plant an endpoint. Even with a
  // verify key next to it, the dev flag is read only from the hook's own environment.
  const judge = await startLocalJudge();
  try {
    await withHome(async (home) => {
      mkdirSync(join(home, ".config", "atbash"), { recursive: true });
      writeFileSync(
        join(home, ".config", "atbash", "config.json"),
        JSON.stringify({
          agentKey: generateKeypair().priv_key,
          judgeEndpoint: judge.endpoint,
          judgeVerifyPubKey: judge.verifyPubKey,
          ATBASH_DEV_ALLOW_LOCAL_JUDGE: "1",
        }),
      );
      const result = await runBuiltHook(makeHookInput(), {}, home);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, DENY_SHAPE, result.stdout);
      assert.match(result.stdout, /ATBASH_DEV_ALLOW_LOCAL_JUDGE/, result.stdout);
    });
    assert.equal(judged(judge.hits), false, `the judge was consulted: ${judge.hits.join(", ")}`);
  } finally {
    await judge.close();
  }
});

test("a local judge with the dev flag and its signing key is used, and its signed ALLOW permits", async () => {
  const judge = await startLocalJudge();
  try {
    await withHome(async (home) => {
      const result = await runBuiltHook(
        makeHookInput(),
        { ...judge.env, ATBASH_AGENT_KEY: generateKeypair().priv_key },
        home,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "", `expected a permit, got ${JSON.stringify(result.stdout)}`);
      assert.equal(
        judged(judge.hits),
        true,
        `the judge was not consulted: ${judge.hits.join(", ")}`,
      );
    });
  } finally {
    await judge.close();
  }
});

test("a local judge whose ALLOW is unsigned or signed by another key is denied", async () => {
  for (const signature of ["none", "foreign"] as const) {
    const judge = await startLocalJudge({ signature });
    try {
      await withHome(async (home) => {
        const result = await runBuiltHook(
          makeHookInput(),
          { ...judge.env, ATBASH_AGENT_KEY: generateKeypair().priv_key },
          home,
        );
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, DENY_SHAPE, `${signature}: ${result.stdout}`);
        assert.match(result.stdout, /Atbash ERROR/, result.stdout);
        assert.equal(judged(judge.hits), true, `${signature}: judge not consulted`);
      });
    } finally {
      await judge.close();
    }
  }
});
