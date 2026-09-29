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

test("the endpoint rule: remote https passes; loopback or plain http needs the flag and a key", () => {
  const key = `02${"ab".repeat(32)}`;
  const flag = { ATBASH_DEV_ALLOW_LOCAL_JUDGE: "1" };
  for (const endpoint of ["", "https://atbash.ai", "https://judge.example.com:8443/x"]) {
    assert.doesNotThrow(() => assertJudgeEndpointAllowed(endpoint, "", {}), endpoint);
  }
  for (const endpoint of [
    "http://127.0.0.1:9",
    "http://localhost:9",
    "https://localhost:9",
    "https://127.9.9.9",
    "http://[::1]:9",
    "http://0.0.0.0:9",
    "http://judge.localhost",
    "http://2130706433",
    "http://[::ffff:127.0.0.1]",
    "http://judge.example.com",
  ]) {
    assert.throws(() => assertJudgeEndpointAllowed(endpoint, "", {}), GuardConfigError, endpoint);
    assert.throws(() => assertJudgeEndpointAllowed(endpoint, "", flag), GuardConfigError, endpoint);
    assert.throws(() => assertJudgeEndpointAllowed(endpoint, key, {}), GuardConfigError, endpoint);
    assert.throws(
      () => assertJudgeEndpointAllowed(endpoint, key, { ATBASH_DEV_ALLOW_LOCAL_JUDGE: "yes" }),
      GuardConfigError,
      endpoint,
    );
    assert.throws(
      () => assertJudgeEndpointAllowed(endpoint, key.slice(2), flag),
      GuardConfigError,
      endpoint,
    );
    assert.doesNotThrow(() => assertJudgeEndpointAllowed(endpoint, key, flag), endpoint);
  }
  assert.throws(() => assertJudgeEndpointAllowed("not a url", key, flag), GuardConfigError);
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
