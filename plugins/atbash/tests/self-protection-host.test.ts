/**
 * Self-protection at the host boundary: the BUILT hook, a real judge on loopback that answers ALLOW
 * to everything (signed, as a developer's local judge), and tool calls that would switch Atbash off.
 * The judge would permit every one of them; the hook must deny them itself, without asking the
 * judge, while reads of the same files and ordinary work still reach the judge and are permitted.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateKeypair } from "@atbash/sdk";

import { makeHookInput } from "./fixtures.js";
import { runBuiltHook, startLocalJudge } from "./local-judge.js";

const DENY_SHAPE = /"permissionDecision":"deny"/;

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

test("calls that would disable or re-point Atbash are denied locally even when the judge allows them", async () => {
  const judge = await startLocalJudge({ verdict: "ALLOW" });
  const home = mkdtempSync(join(tmpdir(), "atbash-selfprotect-home-"));
  const scratch = mkdtempSync(join(tmpdir(), "atbash-selfprotect-scratch-"));
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    // A directory junction needs no privilege on Windows and is a symlink elsewhere.
    symlinkSync(join(home, ".claude"), join(scratch, "innocent"), "junction");
    const env = { ...judge.env, ATBASH_AGENT_KEY: generateKeypair().priv_key };
    // One call per mechanism, through the real hook process; every spelling is pinned in
    // self-protection.test.ts. Kept short: each run is a full hook start.
    const attacks: { tool_name: string; tool_input: Record<string, unknown> }[] = [
      { tool_name: "Bash", tool_input: { command: "claude plugin disable atbash@atbash-ai" } },
      {
        tool_name: "Bash",
        tool_input: { command: `echo ${b64("claude plugin disable atbash")} | base64 -d | sh` },
      },
      {
        tool_name: "Bash",
        tool_input: { command: "ATBASH_ENDPOINT=http://127.0.0.1:1 claude -p hi" },
      },
      { tool_name: "Bash", tool_input: { command: "echo '{}' > ~/.claude/settings.json" } },
      {
        tool_name: "Write",
        tool_input: { file_path: join(home, ".claude", "settings.json"), content: "{}" },
      },
      {
        tool_name: "Write",
        tool_input: { file_path: join(scratch, "innocent", "settings.json"), content: "{}" },
      },
    ];
    for (const call of attacks) {
      const result = await runBuiltHook(makeHookInput(call), env, home);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, DENY_SHAPE, `permitted: ${JSON.stringify(call)}`);
      assert.match(result.stdout, /disable or change/, `${JSON.stringify(call)}: ${result.stdout}`);
    }
    assert.equal(
      judge.hits.some((hit) => hit.endsWith("/api/v1/judge")),
      false,
      "the judge was asked about a self-protection call",
    );

    const benign: { tool_name: string; tool_input: Record<string, unknown> }[] = [
      { tool_name: "Bash", tool_input: { command: "cat ~/.claude/settings.json" } },
      { tool_name: "Bash", tool_input: { command: "git status --short" } },
    ];
    for (const call of benign) {
      const before = judge.hits.length;
      const result = await runBuiltHook(makeHookInput(call), env, home);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "", `denied: ${JSON.stringify(call)}: ${result.stdout}`);
      assert.ok(
        judge.hits.slice(before).some((hit) => hit.endsWith("/api/v1/judge")),
        `the judge was not consulted for ${JSON.stringify(call)}`,
      );
    }
  } finally {
    await judge.close();
    rmSync(scratch, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});
