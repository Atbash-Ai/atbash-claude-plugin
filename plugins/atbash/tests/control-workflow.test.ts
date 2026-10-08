import assert from "node:assert/strict";
import { createPublicKey, publicEncrypt, type JsonWebKey } from "node:crypto";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateKeyDeliveryPair } from "../src/control/keys.js";
import {
  parseProposalActions,
  validateProposalActionsForPurpose,
  type ExecutionView,
  type ProposalView,
} from "../src/control/protocol.js";
import { ControlStore, type PendingJob } from "../src/control/store.js";
import {
  activateCompletedJob,
  cancelControlJob,
  continueControlJob,
  startControlJob,
  submitControlPlan,
} from "../src/control/workflow.js";

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
        name: "Claude",
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
  assert.throws(
    () =>
      parseProposalActions({
        actions: [
          { type: "create_account", network: "public" },
          { type: "create_account", network: "public" },
        ],
      }),
    /at most one account/,
  );
  assert.throws(
    () =>
      parseProposalActions({
        actions: [
          {
            type: "create_agent",
            network: "private",
            organization: "Acme",
            name: "Claude",
            purpose: "Review code",
            risk: "medium",
            keySource: "generate_in_browser",
          },
          { type: "create_account", network: "public" },
        ],
      }),
    /same network/,
  );
});

test("plans are constrained to the lifecycle supported by each authorization purpose", () => {
  const createAgent = parseProposalActions({
    actions: [
      {
        type: "create_agent",
        network: "public",
        organization: "Acme",
        name: "Claude",
        purpose: "Review code",
        risk: "medium",
        keySource: "generate_in_browser",
      },
    ],
  });
  assert.doesNotThrow(() => validateProposalActionsForPurpose(createAgent, "onboard"));

  const localAgent = parseProposalActions({
    actions: [
      {
        type: "create_agent",
        network: "public",
        organization: "Acme",
        name: "Claude",
        purpose: "Review code",
        risk: "medium",
        keySource: "local_public_key",
        agentPubkey: `02${"22".repeat(32)}`,
      },
    ],
  });
  assert.throws(
    () => validateProposalActionsForPurpose(localAgent, "onboard"),
    /browser-generated agent/,
  );

  const updateAgent = parseProposalActions({
    actions: [
      {
        type: "update_agent",
        network: "public",
        organization: "Acme",
        agentPubkey: `02${"22".repeat(32)}`,
        changes: { purpose: "Review code" },
      },
    ],
  });
  assert.doesNotThrow(() => validateProposalActionsForPurpose(updateAgent, "manage"));
  assert.throws(
    () => validateProposalActionsForPurpose(createAgent, "manage"),
    /exactly one agent update/,
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
    host: "claude",
    purpose: "onboard",
    serviceOrigin: "https://atbash.ai",
    store,
    client: client as never,
  });

  assert.equal(output.nextAction, "OPEN_BROWSER");
  assert.equal(output.planPath, join(root, "plans", `${output.jobId}.json`));
  if (process.platform !== "win32")
    assert.equal((await stat(join(root, "plans"))).mode & 0o777, 0o700);
  assert.doesNotMatch(JSON.stringify(output), /SSSS|PRIVATE KEY/);
  const stored = await store.readJob(output.jobId);
  assert.equal(stored.sessionSecret, "S".repeat(43));
  assert.match(stored.keyDeliveryPrivateKeyPem, /PRIVATE KEY/);
});

test("continuing an activated job reports agent status without failing on status errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "atbash-continue-"));
  const store = new ControlStore(root);
  const job: PendingJob = {
    schemaVersion: 1,
    jobId: "job-continue",
    host: "claude",
    purpose: "onboard",
    serviceOrigin: "https://atbash.ai",
    sessionId: "session-id",
    sessionSecret: "consumed-after-activation",
    verificationCode: "ABCD-EFGH",
    verificationUri: "https://atbash.ai/connect/plugin",
    expiresAt: "2099-01-01T00:00:00.000Z",
    pollIntervalMs: 2_000,
    keyDeliveryPrivateKeyPem: "destroyed-after-activation",
    activatedProfileId: "claude-job-continue",
  };
  await store.saveJob(job);

  const ready = await continueControlJob(job.jobId, store, async () => ({
    ready: true,
    state: "ready",
  }));
  const unavailable = await continueControlJob(job.jobId, store, async () => {
    throw new Error("network down");
  });

  assert.equal(ready.nextAction, "DONE");
  assert.deepEqual(ready.agentStatus, { ready: true, state: "ready" });
  assert.equal(unavailable.nextAction, "DONE");
  assert.equal(unavailable.agentStatus?.state, "service_error");
  assert.match(unavailable.message ?? "", /claude-job-continue is active/);
});

test("plans are accepted only from the job's plan path", async () => {
  const root = await mkdtemp(join(tmpdir(), "atbash-plan-"));
  const store = new ControlStore(root);
  const jobId = "job-plan-path";

  for (const path of [join(root, "elsewhere.json"), join(root, "pending", `${jobId}.json`)]) {
    await assert.rejects(submitControlPlan(jobId, path, store), /Write the plan to/);
  }
  await store.preparePlanDirectory();
  await writeFile(store.planPath(jobId), JSON.stringify({ actions: [] }));
  assert.deepEqual(await store.readPlan(jobId), { actions: [] });
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
    host: "claude",
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
        name: "Claude",
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
  const selected = await store.selectedProfile("claude");
  const consumedJob = await store.readJob(job.jobId);
  assert.equal(profileId, "claude-job-activate");
  assert.equal(selected?.profile.organization, "Acme");
  assert.equal(selected?.credential.agentPrivateKey, agentPrivateKey);
  assert.equal(consumedJob.sessionSecret, "consumed-after-activation");
  assert.equal(consumedJob.keyDeliveryPrivateKeyPem, "destroyed-after-activation");
});

test("activation rejects an execution result that names a different delivered agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "atbash-activate-mismatch-"));
  const store = new ControlStore(root);
  const pair = generateKeyDeliveryPair();
  const deliveredPubkey = `02${"44".repeat(32)}`;
  const resultPubkey = `03${"55".repeat(32)}`;
  const sessionId = "session-id";
  const proposalId = "proposal-id";
  const label = `atbash-plugin-key:v1:${sessionId}:${proposalId}:${deliveredPubkey}`;
  const ciphertext = publicEncrypt(
    {
      key: createPublicKey({ key: pair.publicKey as unknown as JsonWebKey, format: "jwk" }),
      oaepHash: "sha256",
      oaepLabel: Buffer.from(label),
    },
    Buffer.from(
      JSON.stringify({
        version: 1,
        agentPubkey: deliveredPubkey,
        agentPrivateKey: "33".repeat(32),
      }),
    ),
  ).toString("base64url");
  const job: PendingJob = {
    schemaVersion: 1,
    jobId: "job-mismatch",
    host: "claude",
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
        name: "Claude",
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
    results: [
      { actionIndex: 0, type: "create_agent", status: "completed", agentPubkey: resultPubkey },
    ],
    keyDeliveries: [
      {
        version: 1,
        algorithm: "RSA-OAEP-256",
        ciphertext,
        label,
        agentPubkey: deliveredPubkey,
      },
    ],
    claimedAt: "2099-01-01T00:00:00.000Z",
    completedAt: "2099-01-01T00:01:00.000Z",
  };

  await assert.rejects(
    activateCompletedJob(job, proposal, execution, store),
    /different agent key/,
  );
  assert.equal(await store.selectedProfile("claude"), null);
});

test("cancelling a control job removes its local pending secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "atbash-cancel-"));
  const store = new ControlStore(root);
  const job: PendingJob = {
    schemaVersion: 1,
    jobId: "job-cancel",
    host: "claude",
    purpose: "onboard",
    serviceOrigin: "https://atbash.ai",
    sessionId: "session-id",
    sessionSecret: "S".repeat(43),
    verificationCode: "ABCD-EFGH",
    verificationUri: "https://atbash.ai/connect/plugin",
    expiresAt: "2099-01-01T00:00:00.000Z",
    pollIntervalMs: 2_000,
    keyDeliveryPrivateKeyPem: "pending-private-key",
  };
  await store.saveJob(job);
  const calls: unknown[][] = [];
  const client = {
    async cancelSession(...args: unknown[]) {
      calls.push(args);
    },
  };

  const result = await cancelControlJob(job.jobId, store, client as never);

  assert.equal(result.status, "cancelled");
  assert.deepEqual(calls, [[job.sessionId, job.sessionSecret]]);
  await assert.rejects(store.readJob(job.jobId), { code: "ENOENT" });
});
