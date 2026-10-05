import assert from "node:assert/strict";
import { createPublicKey, publicEncrypt, type JsonWebKey } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlClient, resolveControlOrigin } from "../src/control/client.js";
import { decryptAgentKey, generateKeyDeliveryPair } from "../src/control/keys.js";
import { ControlStore, type PendingJob } from "../src/control/store.js";

test("key delivery decrypts only the labeled local ciphertext", () => {
  const pair = generateKeyDeliveryPair();
  const sessionId = "8a971b2e-02e5-4f50-9a39-7d21ccbcbb4c";
  const proposalId = "14d3ccfa-df90-4810-9a78-06a38553d631";
  const agentPubkey = `02${"22".repeat(32)}`;
  const agentPrivateKey = "11".repeat(32);
  const label = `atbash-plugin-key:v1:${sessionId}:${proposalId}:${agentPubkey}`;
  const ciphertext = publicEncrypt(
    {
      key: createPublicKey({ key: pair.publicKey as unknown as JsonWebKey, format: "jwk" }),
      oaepHash: "sha256",
      oaepLabel: Buffer.from(label),
    },
    Buffer.from(JSON.stringify({ version: 1, agentPubkey, agentPrivateKey })),
  ).toString("base64url");

  assert.deepEqual(
    decryptAgentKey(
      { version: 1, algorithm: "RSA-OAEP-256", ciphertext, label, agentPubkey },
      pair.privateKeyPem,
    ),
    { agentPubkey, agentPrivateKey },
  );
  assert.throws(
    () =>
      decryptAgentKey(
        {
          version: 1,
          algorithm: "RSA-OAEP-256",
          ciphertext,
          label: `${label}-changed`,
          agentPubkey,
        },
        pair.privateKeyPem,
      ),
    /decrypt|oaep/i,
  );
});

test("pending secrets are stored in a restricted local file", async () => {
  const root = await mkdtemp(join(tmpdir(), "atbash-control-"));
  const store = new ControlStore(root);
  const job: PendingJob = {
    schemaVersion: 1,
    jobId: "job-1",
    host: "claude",
    purpose: "onboard",
    serviceOrigin: "https://atbash.ai",
    sessionId: "session-id",
    sessionSecret: "secret-value",
    verificationCode: "ABCD-EFGH",
    verificationUri: "https://atbash.ai/connect/plugin",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    pollIntervalMs: 2_000,
    keyDeliveryPrivateKeyPem: "private-key",
  };

  await store.saveJob(job);
  assert.deepEqual(await store.readJob(job.jobId), job);
  const path = join(root, "pending", "job-1.json");
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(await readFile(path, "utf8"), /secret-value/);
});

test("control client keeps the bearer out of URLs and sends it only in authorization", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), authorization: headers.get("authorization") });
    return new Response(
      JSON.stringify({
        id: "session-id",
        host: "claude",
        purpose: "onboard",
        clientVersion: "0.5.0",
        status: "pending_identity",
        identityBound: false,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const client = new ControlClient("https://atbash.ai", fetcher);
  await client.getSession("session-id", "S".repeat(43));

  assert.equal(calls[0]?.url, "https://atbash.ai/api/v1/plugin/sessions/session-id");
  assert.equal(calls[0]?.authorization, `Bearer ${"S".repeat(43)}`);
  assert.doesNotMatch(calls[0]?.url ?? "", /SSSS/);
});

test("control service requires HTTPS except on loopback", () => {
  assert.equal(resolveControlOrigin("https://example.com/path"), "https://example.com");
  assert.equal(resolveControlOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.throws(() => resolveControlOrigin("http://example.com"), /HTTPS/);
});
