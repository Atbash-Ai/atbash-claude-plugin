import { createHash } from "node:crypto";
import { derivePublicKey, isValidPrivateKey } from "@atbash/sdk";
import { ControlClient } from "./client.js";
import { ControlStore, type AgentCredential, type AgentProfile } from "./store.js";

export interface ConnectedExistingProfile {
  profileId: string;
  host: "codex" | "claude";
  organization: string;
  network: "public" | "private";
  agentPubkey: string;
}

export async function connectExistingAgent(input: {
  jobId: string;
  privateKey: string;
  store?: ControlStore;
  client?: ControlClient;
}): Promise<ConnectedExistingProfile> {
  const store = input.store ?? new ControlStore();
  const privateKey = input.privateKey.trim().replace(/^0x/, "").toLowerCase();
  if (!isValidPrivateKey(privateKey)) throw new Error("The local agent key is invalid.");
  const agentPubkey = derivePublicKey(privateKey).toLowerCase();
  const job = await store.readJob(input.jobId);
  const sessionSecret = job.sessionSecret;
  const client = input.client ?? new ControlClient(job.serviceOrigin);
  const session = await client.getSession(job.sessionId, sessionSecret);
  if (!session.identityBound)
    throw new Error("Verify the owner wallet in the Connect Atbash page first.");
  const discovery = await client.getResources(job.sessionId, sessionSecret);
  if (!discovery?.authoritative)
    throw new Error("Atbash resource discovery is incomplete. Try again before connecting a key.");
  const agent = discovery.agents.find(
    (candidate) => candidate.pubkey.toLowerCase() === agentPubkey,
  );
  if (!agent)
    throw new Error("This local key does not match an agent owned by the verified wallet.");

  const fingerprint = createHash("sha256").update(agentPubkey).digest("hex").slice(0, 20);
  const credentialId = `existing-${fingerprint}`;
  const profileId = `${job.host}-${fingerprint}`;
  const createdAt = new Date().toISOString();
  const credential: AgentCredential = {
    schemaVersion: 1,
    credentialId,
    agentPrivateKey: privateKey,
    agentPubkey,
    createdAt,
  };
  const profile: AgentProfile = {
    schemaVersion: 1,
    profileId,
    credentialId,
    host: job.host,
    organization: agent.organization,
    network: agent.network,
    agentPubkey,
    serviceOrigin: job.serviceOrigin,
    createdAt,
  };
  await store.activate({ credential, profile });
  try {
    await client.cancelSession(job.sessionId, sessionSecret);
  } catch {
    // The local profile is active; the short-lived read-only session will expire.
  }
  job.activatedProfileId = profileId;
  job.activatedAt = createdAt;
  job.keyDeliveryPrivateKeyPem = "destroyed-after-existing-agent-connect";
  job.sessionSecret = "consumed-after-existing-agent-connect";
  await store.saveJob(job);
  return {
    profileId,
    host: job.host,
    organization: agent.organization,
    network: agent.network,
    agentPubkey,
  };
}
