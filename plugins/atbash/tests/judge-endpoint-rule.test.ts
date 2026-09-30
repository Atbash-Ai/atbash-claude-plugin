/**
 * The judge endpoint rule as a function, and the status report that must agree with the hook. The
 * hook-level proof (the built hook against a real local judge) is judge-endpoint.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateKeypair } from "@atbash/sdk";

import { assertJudgeEndpointAllowed, GuardConfigError } from "../src/atbash/guard.js";
import { getAtbashStatus } from "../src/atbash/status.js";

test("the endpoint rule: only Atbash's own judge passes on its own; any other needs env endpoint, env key and the flag", () => {
  const key = `02${"ab".repeat(32)}`;
  // Atbash's own judge, from anywhere (env or config file), needs nothing more.
  for (const endpoint of ["", "https://atbash.ai", "https://www.atbash.ai/", "https://ATBASH.ai"]) {
    assert.doesNotThrow(() => assertJudgeEndpointAllowed(endpoint, {}), endpoint);
  }
  for (const endpoint of [
    // Remote https that is not Atbash's: the attacker's own judge with the attacker's own key.
    "https://judge.example.com:8443/x",
    "https://atbash.ai.attacker.example",
    "https://user:pw@atbash.ai",
    "http://atbash.ai",
    // Local, however it is spelled.
    "http://127.0.0.1:9",
    "http://localhost:9",
    "https://localhost:9",
    "https://localhost.:9",
    "https://127.9.9.9",
    "http://[::1]:9",
    "http://0.0.0.0:9",
    "http://judge.localhost",
    "http://2130706433",
    "http://[::ffff:127.0.0.1]",
    "https://loopback.example.test",
  ]) {
    const full = {
      ATBASH_ENDPOINT: endpoint,
      ATBASH_JUDGE_VERIFY_PUBKEY: key,
      ATBASH_DEV_ALLOW_LOCAL_JUDGE: "1",
    };
    assert.throws(() => assertJudgeEndpointAllowed(endpoint, {}), GuardConfigError, endpoint);
    // Each of the three missing on its own is a refusal.
    for (const drop of Object.keys(full) as (keyof typeof full)[]) {
      const env: Record<string, string> = { ...full };
      delete env[drop];
      assert.throws(
        () => assertJudgeEndpointAllowed(endpoint, env),
        GuardConfigError,
        `${endpoint} without ${drop}`,
      );
    }
    // The endpoint came from the config file (the env names a different one).
    assert.throws(
      () => assertJudgeEndpointAllowed(endpoint, { ...full, ATBASH_ENDPOINT: "https://atbash.ai" }),
      GuardConfigError,
      endpoint,
    );
    for (const bad of [
      { ATBASH_DEV_ALLOW_LOCAL_JUDGE: "yes" },
      { ATBASH_JUDGE_VERIFY_PUBKEY: `0x${key}` },
      { ATBASH_JUDGE_VERIFY_PUBKEY: key.slice(2) },
    ]) {
      assert.throws(
        () => assertJudgeEndpointAllowed(endpoint, { ...full, ...bad }),
        GuardConfigError,
        `${endpoint} ${JSON.stringify(bad)}`,
      );
    }
    assert.doesNotThrow(() => assertJudgeEndpointAllowed(endpoint, full), endpoint);
  }
  assert.throws(
    () =>
      assertJudgeEndpointAllowed("not a url", {
        ATBASH_ENDPOINT: "not a url",
        ATBASH_JUDGE_VERIFY_PUBKEY: key,
        ATBASH_DEV_ALLOW_LOCAL_JUDGE: "1",
      }),
    GuardConfigError,
  );
});

test("status reports the refused local judge instead of ready", async () => {
  const saved = { ...process.env };
  const home = mkdtempSync(join(tmpdir(), "atbash-endpoint-status-"));
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.ATBASH_ENDPOINT = "http://127.0.0.1:9";
    process.env.ATBASH_AGENT_KEY = generateKeypair().priv_key;
    delete process.env.ATBASH_DEV_ALLOW_LOCAL_JUDGE;
    delete process.env.ATBASH_JUDGE_VERIFY_PUBKEY;
    const status = await getAtbashStatus();
    assert.equal(status.ready, false);
    assert.equal(status.state, "configuration_error");
    assert.match(status.ready ? "" : status.message, /ATBASH_DEV_ALLOW_LOCAL_JUDGE/);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    rmSync(home, { force: true, recursive: true });
  }
});
