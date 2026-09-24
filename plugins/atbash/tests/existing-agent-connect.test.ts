import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateKeypair } from "@atbash/sdk";
import { startLocalImportServer } from "../src/control/local-import.js";
import { ControlStore, type PendingJob } from "../src/control/store.js";

test("loopback import connects a wallet-owned agent without sending its private key", async () => {
  const root = await mkdtemp(join(tmpdir(), "atbash-existing-agent-"));
  const store = new ControlStore(root);
  const keypair = generateKeypair();
  const job: PendingJob = {
    schemaVersion: 1,
    jobId: "existing-job",
    host: "claude",
    purpose: "onboard",
    serviceOrigin: "https://atbash.ai",
    sessionId: "session-id",
    sessionSecret: "S".repeat(43),
    verificationCode: "ABCD-EFGH",
    verificationUri: "https://atbash.ai/connect/plugin",
    expiresAt: "2099-01-01T00:00:00.000Z",
    pollIntervalMs: 2_000,
    keyDeliveryPrivateKeyPem: "pending-delivery-key",
  };
  await store.saveJob(job);
  const calls: unknown[][] = [];
  const client = {
    async getSession(...args: unknown[]) {
      calls.push(args);
      return {
        id: job.sessionId,
        host: "claude" as const,
        purpose: "onboard" as const,
        clientVersion: "0.5.0",
        status: "identity_bound" as const,
        identityBound: true,
        expiresAt: job.expiresAt,
      };
    },
    async getResources(...args: unknown[]) {
      calls.push(args);
      return {
        authoritative: true,
        setupState: "ready_existing" as const,
        hasAtbashAccount: true,
        accounts: [{ network: "public" as const }],
        organizations: [{ name: "Acme", network: "public" as const, active: true }],
        agents: [
          {
            pubkey: keypair.pub_key,
            organization: "Acme",
            network: "public" as const,
            name: "Existing",
            purpose: "Review",
            risk: "medium",
            active: true,
            jailed: false,
          },
        ],
        unavailableNetworks: [],
      };
    },
    async cancelSession(...args: unknown[]) {
      calls.push(args);
    },
  };
  const local = await startLocalImportServer({
    jobId: job.jobId,
    store,
    client: client as never,
    timeoutMs: 5_000,
  });
  const form = await fetch(local.localUri);
  assert.equal(form.status, 200);
  assert.equal(form.headers.get("cache-control"), "no-store");
  assert.match(form.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const html = await form.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf);

  const rejected = await fetch(local.localUri, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://attacker.example",
    },
    body: new URLSearchParams({ csrf, privateKey: keypair.priv_key }),
  });
  assert.equal(rejected.status, 403);

  const accepted = await fetch(local.localUri, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: new URL(local.localUri).origin,
    },
    body: new URLSearchParams({ csrf, privateKey: keypair.priv_key }),
  });
  assert.equal(accepted.status, 200);
  const profile = await local.completion;
  assert.equal(profile.organization, "Acme");
  assert.equal(
    (await store.selectedProfile("claude"))?.credential.agentPrivateKey,
    keypair.priv_key,
  );
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(keypair.priv_key, "i"));
});
