/**
 * Shadow mode end to end: the development SDK (the one that enforces the organisation's mode on
 * the client) against a real judge on loopback whose answers are signed, with the hook's runner
 * on top. Nothing in the SDK is replaced. The production SDK does not apply modes yet, so these
 * tests construct the development SDK directly; the last one runs the shipped runtime when it is a
 * development build.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Atbash as ClientEnforcingAtbash, generateKeypair } from "@atbash/sdk-dev";

import { executePreToolUse } from "../src/hook/cli.js";
import { evaluatePreToolUse, type HookOutcome } from "../src/hook/runner.js";
import { recordUnenforcedPermit } from "../src/hook/shadow-log.js";
import { makeHookInput } from "./fixtures.js";
import {
  runBuiltHook,
  startLocalJudge,
  type LocalJudge,
  type LocalJudgeOptions,
} from "./local-judge.js";

process.env.ATBASH_TELEMETRY_DISABLED = "1";

const configured = { hasConfiguration: () => true, isSetupCall: () => false };

async function withJudge<T>(
  options: LocalJudgeOptions,
  run: (judge: LocalJudge, home: string) => Promise<T>,
): Promise<T> {
  const judge = await startLocalJudge(options);
  const home = mkdtempSync(join(tmpdir(), "atbash-shadow-home-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  // The SDK reads its configuration file from the home directory; keep the developer's out.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await run(judge, home);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { force: true, recursive: true });
    await judge.close();
  }
}

function guardFor(judge: LocalJudge) {
  return () =>
    ClientEnforcingAtbash.fromConfig({
      agentKey: generateKeypair().priv_key,
      judge: { policy: "self-hosted", endpoint: judge.endpoint, verifyPubKey: judge.verifyPubKey },
      failClosed: true,
      requireEnforcement: true,
      timeoutMs: 5_000,
    });
}

function judge(options: LocalJudgeOptions): Promise<HookOutcome> {
  return withJudge(options, (server) =>
    evaluatePreToolUse(makeHookInput(), guardFor(server), configured),
  );
}

test("a signed shadow mode lets a BLOCK run and carries what would have happened", async () => {
  const outcome = await judge({ verdict: "BLOCK", enforcementMode: "shadow" });

  assert.equal(outcome.allow, true);
  assert.equal(outcome.allow && outcome.source, "atbash");
  const note = outcome.allow ? outcome.unenforced : undefined;
  assert.equal(note?.mode, "shadow");
  assert.equal(note?.wouldVerdict, "BLOCK");
  assert.equal(note?.pending, false);
  assert.equal(note?.reason, "denied by the test judge");
  assert.match(note?.toolCallId ?? "", /\S/);
});

test("a signed shadow mode lets a HOLD run, and monitor and off relax the same way", async () => {
  const held = await judge({ verdict: "HOLD", enforcementMode: "shadow" });
  assert.equal(held.allow && held.unenforced?.wouldVerdict, "HOLD");

  for (const enforcementMode of ["monitor", "off"] as const) {
    const outcome = await judge({ verdict: "BLOCK", enforcementMode });
    assert.equal(outcome.allow, true, enforcementMode);
    assert.equal(outcome.allow && outcome.unenforced?.mode, enforcementMode);
    assert.equal(outcome.allow && outcome.unenforced?.wouldVerdict, "BLOCK");
  }
});

test("the fast acknowledgement permits at once and is marked as not judged yet", async () => {
  const outcome = await judge({ verdict: "BLOCK", enforcementMode: "shadow", fastAck: true });

  assert.equal(outcome.allow, true);
  const note = outcome.allow ? outcome.unenforced : undefined;
  assert.equal(note?.mode, "shadow");
  assert.equal(note?.pending, true);
  assert.equal(note?.wouldVerdict, undefined);
});

test("an ALLOW in shadow mode is a plain permit with nothing to report", async () => {
  const outcome = await judge({ verdict: "ALLOW", enforcementMode: "shadow" });
  assert.deepEqual(outcome, { allow: true, source: "atbash" });
});

test("enforce mode, an unsigned mode and a mode for another call all still block", async () => {
  const enforced = await judge({ verdict: "BLOCK", enforcementMode: "enforce" });
  assert.equal(enforced.allow, false);
  assert.equal(enforced.allow ? undefined : enforced.verdict, "BLOCK");

  // No mode stated at all: the judge's verdict stands.
  const unstated = await judge({ verdict: "BLOCK" });
  assert.equal(unstated.allow ? undefined : unstated.verdict, "BLOCK");

  // A shadow mode that is not signed by the judge's key is not a mode.
  for (const signature of ["none", "foreign"] as const) {
    const forged = await judge({ verdict: "BLOCK", enforcementMode: "shadow", signature });
    assert.equal(forged.allow, false, signature);
    const ack = await judge({
      verdict: "BLOCK",
      enforcementMode: "shadow",
      fastAck: true,
      signature,
    });
    assert.equal(ack.allow, false, `${signature} fast acknowledgement`);
  }
});

test("a judge ALLOW with allow:false is denied by the client-enforcing SDK too", async () => {
  for (const enforcementMode of [undefined, "enforce"] as const) {
    const outcome = await judge({
      allowField: false,
      ...(enforcementMode === undefined ? {} : { enforcementMode }),
    });
    assert.equal(outcome.allow, false, String(enforcementMode));
  }
});

test("the hook permits a shadow-mode BLOCK and writes the would-block line", async () => {
  await withJudge({ verdict: "BLOCK", enforcementMode: "shadow" }, async (server, home) => {
    const path = join(home, "shadow.log");
    const echoed: string[] = [];
    const output = await executePreToolUse(JSON.stringify(makeHookInput()), {
      createGuard: guardFor(server),
      bootstrap: configured,
      recordUnenforced: (note, toolName) =>
        recordUnenforcedPermit(note, toolName, { path, echo: (line) => echoed.push(line) }),
    });

    assert.equal(output, "", "a shadow-mode BLOCK is a permit");
    const log = readFileSync(path, "utf8");
    assert.match(log, /^\S+ would block: denied by the test judge \(tool=Bash mode=shadow ref=/);
    assert.equal(echoed.length, 1);
    assert.match(echoed[0] ?? "", /^\[atbash\] would block: denied by the test judge/);
  });
});

// The committed runtime is a development build on `dev` and a production build on `main`. Only the
// development SDK applies the organisation's mode today; drop the condition once production does.
const shippedEnvironment = (
  JSON.parse(readFileSync("runtime/manifest.json", "utf8")) as { environment?: string }
).environment;

test(
  "the shipped runtime permits a shadow-mode BLOCK, logs it, and still blocks under enforce",
  { skip: shippedEnvironment === "dev" ? false : "the production SDK does not apply modes yet" },
  async () => {
    const run = (options: LocalJudgeOptions) =>
      withJudge(options, async (server, home) => {
        const result = await runBuiltHook(
          makeHookInput(),
          { ...server.env, ATBASH_AGENT_KEY: generateKeypair().priv_key },
          home,
          "runtime/pre-tool-use.cjs",
        );
        const path = join(home, ".config", "atbash", "shadow.log");
        return { result, log: existsSync(path) ? readFileSync(path, "utf8") : "" };
      });

    const shadow = await run({ verdict: "BLOCK", enforcementMode: "shadow" });
    assert.equal(shadow.result.code, 0, shadow.result.stderr);
    assert.equal(shadow.result.stdout, "", "a shadow-mode BLOCK is a permit");
    assert.match(shadow.log, /^\S+ would block: denied by the test judge \(tool=Bash mode=shadow/);
    assert.match(shadow.result.stderr, /\[atbash\] would block: denied by the test judge/);

    const acknowledged = await run({ verdict: "BLOCK", enforcementMode: "shadow", fastAck: true });
    assert.equal(acknowledged.result.stdout, "", "the fast acknowledgement is a permit");
    assert.match(acknowledged.log, /^\S+ recorded, not judged yet: /);

    const enforced = await run({ verdict: "BLOCK", enforcementMode: "enforce" });
    assert.match(enforced.result.stdout, /"permissionDecision":"deny"/);
    assert.match(enforced.result.stdout, /Atbash BLOCK/);
    assert.equal(enforced.log, "");
  },
);
