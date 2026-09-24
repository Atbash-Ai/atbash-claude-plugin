import assert from "node:assert/strict";
import { createPublicKey, publicEncrypt, type JsonWebKey } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateKeyDeliveryPair } from "../src/control/keys.js";
import {
  parseProposalActions,
  type ExecutionView,
  type ProposalView,
} from "../src/control/protocol.js";
import { ControlStore, type PendingJob } from "../src/control/store.js";
import { activateCompletedJob, startControlJob } from "../src/control/workflow.js";

test("plan parser permits only the bounded dashboard action vocabulary", () => {
  const actions = parseProposalActions({
    actions: [
      { type: "create_account", network: "public" },
      {
        type: "create_organization",
        network: "public",
        name: "Acme",
        description: "AI operations",
      },
      { type: "activate_free_plan", network: "public", organization: "Acme" },
      {
        type: "create_agent",
        network: "public",
        organization: "Acme",
        name: "Codex",
        purpose: "Review code",
        risk: "medium",
        keySource: "generate_in_browser",
      },
    ],
  });
  assert.equal(actions.length, 4);
  assert.throws(
    () => parseProposalActions({ actions: [{ type: "raw_chain_call", operation: "admin" }] }),
    /unsupported/,
  );
  assert.throws(
    () =>
      parseProposalActions({
        actions: [{ type: "create_account", network: "public", privateKey: "secret" }],
      }),
    /unknown fields/,
  );
});

test("start returns only public pairing data and persists helper secrets locally", async () => {
  const root = await mkdtemp(join(tmpdir(), "atbash-workflow-"));
  const store = new ControlStore(root);
  const client = {
    createSession: async () => ({
      sessionId: "session-id",
      sessionSecret: "S".repeat(43),
      verificationCode: "ABCD-EFGH",
      verificationUri: "https://atbash.ai/connect/plugin?session=session-id&code=ABCD-EFGH",
      status: "pending_identity" as const,
      expiresAt: "2099-01-01T00:00:00.000Z",
      pollIntervalMs: 2_000,
    }),
  };
  const output = await startControlJob({
    host: "codex",
    purpose: "onboard",
    serviceOrigin: "https://atbash.ai",
    store,
    client: client as never,
  });

  assert.equal(output.nextAction, "OPEN_BROWSER");
  assert.doesNotMatch(JSON.stringify(output), /SSSS|PRIVATE KEY/);
  const stored = await store.readJob(output.jobId);
  assert.equal(stored.sessionSecret, "S".repeat(43));
  assert.match(stored.keyDeliveryPrivateKeyPem, /PRIVATE KEY/);
});

test("completed browser execution activates a host profile and destroys transient authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "atbash-activate-"));
  const store = new ControlStore(root);
  const pair = generateKeyDeliveryPair();
  const agentPubkey = `02${"44".repeat(32)}`;
  const agentPrivateKey = "33".repeat(32);
  const sessionId = "session-id";
  const proposalId = "proposal-id";
  const label = `atbash-plugin-key:v1:${sessionId}:${proposalId}:${agentPubkey}`;
  const ciphertext = publicEncrypt(
    {
      key: createPublicKey({ key: pair.publicKey as unknown as JsonWebKey, format: "jwk" }),
      oaepHash: "sha256",
      oaepLabel: Buffer.from(label),
    },
    Buffer.from(JSON.stringify({ version: 1, agentPubkey, agentPrivateKey })),
  ).toString("base64url");
  const job: PendingJob = {
    schemaVersion: 1,
    jobId: "job-activate",
    host: "codex",
    purpose: "onboard",
    serviceOrigin: "https://atbash.ai",
    sessionId,
    sessionSecret: "S".repeat(43),
    verificationCode: "ABCD-EFGH",
    verificationUri: "https://atbash.ai/connect/plugin",
    expiresAt: "2099-01-01T00:00:00.000Z",
    pollIntervalMs: 2_000,
    keyDeliveryPrivateKeyPem: pair.privateKeyPem,
  };
  await store.saveJob(job);
  const proposal: ProposalView = {
    id: proposalId,
    sessionId,
    revision: 1,
    proposalHash: "a".repeat(64),
    actions: [
      {
        type: "create_agent",
        network: "public",
        organization: "Acme",
        name: "Codex",
        purpose: "Review code",
        risk: "medium",
        keySource: "generate_in_browser",
      },
    ],
    status: "consumed",
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2099-01-01T00:00:00.000Z",
  };
  const execution: ExecutionView = {
    id: "execution-id",
    sessionId,
    proposalId,
    proposalHash: proposal.proposalHash,
    status: "completed",
    results: [{ actionIndex: 0, type: "create_agent", status: "completed", agentPubkey }],
    keyDeliveries: [{ version: 1, algorithm: "RSA-OAEP-256", ciphertext, label, agentPubkey }],
    claimedAt: "2099-01-01T00:00:00.000Z",
    completedAt: "2099-01-01T00:01:00.000Z",
  };

  const profileId = await activateCompletedJob(job, proposal, execution, store);
  const selected = await store.selectedProfile("codex");
  const consumedJob = await store.readJob(job.jobId);
  assert.equal(profileId, "codex-job-activate");
  assert.equal(selected?.profile.organization, "Acme");
  assert.equal(selected?.credential.agentPrivateKey, agentPrivateKey);
  assert.equal(consumedJob.sessionSecret, "consumed-after-activation");
  assert.equal(consumedJob.keyDeliveryPrivateKeyPem, "destroyed-after-activation");
});
