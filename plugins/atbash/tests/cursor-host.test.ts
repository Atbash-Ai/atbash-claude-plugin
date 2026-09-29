import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateKeypair } from "@atbash/sdk";

import { createJudgeSigner } from "./local-judge.js";

test("Cursor stdin through shipped shim preserves judge ALLOW BLOCK and HOLD", async () => {
  for (const verdict of ["ALLOW", "BLOCK", "HOLD"] as const) {
    let judged = false;
    // A loopback judge is accepted only as a developer's signed local judge (see judge-endpoint.test).
    const signer = createJudgeSigner();
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (url.pathname === "/api/ai/exists") {
          res.end(
            JSON.stringify({
              registered: true,
              pubkey: url.searchParams.get("pubkey"),
              org_encryption_pubkey: null,
            }),
          );
        } else if (url.pathname === "/api/risk-engine") {
          res.end(
            JSON.stringify({
              policy: "",
              default_policy: "default",
              is_custom: false,
              is_jailed: false,
            }),
          );
        } else if (url.pathname === "/api/v1/judge") {
          judged = true;
          const body = Buffer.from(
            JSON.stringify({
              verdict,
              action_type: verdict === "HOLD" ? "hold_for_user_confirm" : verdict.toLowerCase(),
              allow: verdict === "ALLOW",
              reason: "cursor fixture",
              tool_call_id: "cursor-test",
            }),
          );
          res.setHeader("X-Atbash-Signature", signer.sign(body));
          res.end(body);
        } else {
          res.statusCode = 404;
          res.end("{}");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const home = mkdtempSync(join(tmpdir(), "atbash-cursor-test-"));
    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(process.execPath, ["dist/pre-tool-use.cjs"], {
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              TEMP: process.env.TEMP,
              TMP: process.env.TMP,
              HOME: home,
              USERPROFILE: home,
              ATBASH_ENDPOINT: `http://127.0.0.1:${address.port}`,
              ATBASH_JUDGE_VERIFY_PUBKEY: signer.verifyPubKey,
              ATBASH_DEV_ALLOW_LOCAL_JUDGE: "1",
              ATBASH_AGENT_KEY: generateKeypair().priv_key,
            },
          });
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (data) => {
            stdout += data;
          });
          child.stderr.on("data", (data) => {
            stderr += data;
          });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout, stderr }));
          child.stdin.end(
            JSON.stringify({
              hook_event_name: "preToolUse",
              cursor_version: "3.20.21",
              workspace_roots: [process.cwd()],
              session_id: "cursor-test",
              tool_name: "Shell",
              tool_input: { command: "git status --short" },
            }),
          );
        },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.equal(judged, true, result.stdout);
      if (verdict === "ALLOW") assert.equal(result.stdout, "");
      else
        assert.deepEqual(JSON.parse(result.stdout), {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `Atbash ${verdict}: cursor fixture Reference: cursor-test.`,
          },
        });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  }
});
