import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { getAtbashStatus } from "../atbash/status.js";
import { ControlApiError, ControlClient, resolveControlOrigin } from "./client.js";
import { decryptAgentKey, generateKeyDeliveryPair } from "./keys.js";
import {
  parseProposalActions,
  validateProposalActionsForPurpose,
  type ControlHost,
  type ControlPurpose,
  type ExecutionView,
  type ProposalView,
  type PublicJobView,
  type SessionView,
  type SetupInventory,
  type AgentStatusSummary,
} from "./protocol.js";
import { ControlStore, type AgentCredential, type AgentProfile, type PendingJob } from "./store.js";

export type AgentStatusCheck = () => Promise<AgentStatusSummary>;

async function defaultStatusCheck(): Promise<AgentStatusSummary> {
  const status = await getAtbashStatus();
  return status.ready
    ? { ready: true, state: status.state }
    : { ready: false, state: status.state, message: status.message };
}

// Checked inside the helper so verifying setup never needs a separately judged tool call.
async function activeAgentStatus(check: AgentStatusCheck): Promise<AgentStatusSummary> {
  try {
    return await check();
  } catch {
    return {
      ready: false,
      state: "service_error",
      message: "Atbash status could not be retrieved. The profile is still active.",
    };
  }
}

export const CONTROL_CLIENT_VERSION = "0.5.0";

function publicExecution(execution: ExecutionView): NonNullable<PublicJobView["execution"]> {
  const { keyDeliveries, ...safe } = execution;
  return { ...safe, keyDeliveryCount: keyDeliveries.length };
}

function nextAction(input: {
  session: SessionView;
  discovery?: SetupInventory | null | undefined;
  proposal?: ProposalView | null | undefined;
  execution?: ExecutionView | null | undefined;
  activated: boolean;
}): PublicJobView["nextAction"] {
  if (input.activated) return "DONE";
  if (input.execution?.status === "completed") return "ACTIVATE";
  if (input.execution?.status === "needs_action") return "RECOVER";
  if (input.execution?.status === "executing") return "WAIT";
  if (input.proposal?.status === "awaiting_approval" || input.proposal?.status === "approved")
    return "REVIEW_IN_BROWSER";
  if (input.session.status === "pending_identity") return "OPEN_BROWSER";
  if (input.session.identityBound && input.discovery) return "PREPARE_PLAN";
  if (["cancelled", "rejected", "expired"].includes(input.session.status)) return "RECOVER";
  return "WAIT";
}

function view(input: {
  job: PendingJob;
  session: SessionView;
  discovery?: SetupInventory | null;
  proposal?: ProposalView | null;
  execution?: ExecutionView | null;
  message?: string;
  planPath?: string;
  agentStatus?: AgentStatusSummary;
}): PublicJobView {
  return {
    schemaVersion: 1,
    jobId: input.job.jobId,
    host: input.job.host,
    purpose: input.job.purpose,
    status: input.session.status,
    verificationCode: input.job.verificationCode,
    verificationUri: input.job.verificationUri,
    expiresAt: input.job.expiresAt,
    ...(input.planPath ? { planPath: input.planPath } : {}),
    nextAction: nextAction({
      session: input.session,
      discovery: input.discovery,
      proposal: input.proposal,
      execution: input.execution,
      activated: Boolean(input.job.activatedProfileId),
    }),
    ...(input.discovery ? { discovery: input.discovery } : {}),
    ...(input.proposal ? { proposal: input.proposal } : {}),
    ...(input.execution ? { execution: publicExecution(input.execution) } : {}),
    ...(input.agentStatus ? { agentStatus: input.agentStatus } : {}),
    ...(input.message ? { message: input.message } : {}),
  };
}

function clientFor(job: PendingJob): ControlClient {
  return new ControlClient(job.serviceOrigin);
}

export async function startControlJob(input: {
  host: ControlHost;
  purpose: ControlPurpose;
  deviceName?: string;
  serviceOrigin?: string;
  store?: ControlStore;
  client?: ControlClient;
}): Promise<PublicJobView> {
  const store = input.store ?? new ControlStore();
  const serviceOrigin = resolveControlOrigin(input.serviceOrigin);
  const client = input.client ?? new ControlClient(serviceOrigin);
  const keyDelivery = generateKeyDeliveryPair();
  const created = await client.createSession({
    host: input.host,
    purpose: input.purpose,
    clientVersion: CONTROL_CLIENT_VERSION,
    deviceName: input.deviceName?.trim() || hostname().slice(0, 120),
    keyDeliveryPublicKey: keyDelivery.publicKey,
  });
  const job: PendingJob = {
    schemaVersion: 1,
    jobId: randomUUID(),
    host: input.host,
    purpose: input.purpose,
    serviceOrigin,
    sessionId: created.sessionId,
    sessionSecret: created.sessionSecret,
    verificationCode: created.verificationCode,
    verificationUri: created.verificationUri,
    expiresAt: created.expiresAt,
    pollIntervalMs: created.pollIntervalMs,
    keyDeliveryPrivateKeyPem: keyDelivery.privateKeyPem,
  };
  await store.saveJob(job);
  await store.preparePlanDirectory();
  return {
    schemaVersion: 1,
    jobId: job.jobId,
    host: job.host,
    purpose: job.purpose,
    status: created.status,
    verificationCode: created.verificationCode,
    verificationUri: created.verificationUri,
    expiresAt: created.expiresAt,
    planPath: store.planPath(job.jobId),
    nextAction: "OPEN_BROWSER",
  };
}

export async function inspectControlJob(
  jobId: string,
  store = new ControlStore(),
): Promise<PublicJobView> {
  const job = await store.readJob(jobId);
  const client = clientFor(job);
  const session = await client.getSession(job.sessionId, job.sessionSecret);
  const discovery = session.identityBound
    ? await client.getResources(job.sessionId, job.sessionSecret)
    : null;
  const proposal = session.identityBound
    ? await client.getProposal(job.sessionId, job.sessionSecret)
    : null;
  const execution = ["executing", "needs_action", "completed"].includes(session.status)
    ? await client.getLatestExecution(job.sessionId, job.sessionSecret)
    : null;
  if (execution && job.executionId !== execution.id) {
    job.executionId = execution.id;
    await store.saveJob(job);
  }
  return view({
    job,
    session,
    discovery,
    proposal,
    execution,
    planPath: store.planPath(job.jobId),
  });
}

export async function submitControlPlan(
  jobId: string,
  inputPath: string,
  store = new ControlStore(),
): Promise<PublicJobView> {
  const planPath = store.planPath(jobId);
  if (resolve(inputPath) !== planPath)
    throw new Error(`Write the plan to ${planPath} and pass that path to --input.`);
  const job = await store.readJob(jobId);
  const client = clientFor(job);
  const session = await client.getSession(job.sessionId, job.sessionSecret);
  if (!session.identityBound)
    throw new Error("Open the verification URL and verify the wallet before preparing a plan.");
  const actions = parseProposalActions(await store.readPlan(jobId));
  validateProposalActionsForPurpose(actions, job.purpose);
  const proposal = await client.submitProposal(job.sessionId, job.sessionSecret, actions);
  job.proposalId = proposal.id;
  await store.saveJob(job);
  const discovery = await client.getResources(job.sessionId, job.sessionSecret);
  return view({
    job,
    session: { ...session, status: "awaiting_approval" },
    discovery,
    proposal,
    planPath,
  });
}

export async function activateCompletedJob(
  job: PendingJob,
  proposal: ProposalView,
  execution: ExecutionView,
  store: ControlStore,
): Promise<string> {
  if (job.activatedProfileId) return job.activatedProfileId;
  const successfulGenerated = execution.results.filter(
    (result) =>
      result.type === "create_agent" && result.status === "completed" && result.agentPubkey,
  );
  if (successfulGenerated.length !== 1 || execution.keyDeliveries.length !== 1)
    throw new Error("Automatic activation requires exactly one securely delivered agent key.");
  const delivery = execution.keyDeliveries[0];
  const successful = successfulGenerated[0];
  if (!delivery || !successful)
    throw new Error("The completed execution is missing its agent key result.");
  const resultPubkey = successful.agentPubkey;
  if (!resultPubkey) throw new Error("The completed execution is missing its agent public key.");
  const decrypted = decryptAgentKey(delivery, job.keyDeliveryPrivateKeyPem);
  if (
    resultPubkey.toLowerCase() !== delivery.agentPubkey.toLowerCase() ||
    resultPubkey.toLowerCase() !== decrypted.agentPubkey
  )
    throw new Error("The completed execution returned a different agent key than it delivered.");
  const action = proposal.actions[successful.actionIndex];
  if (!action || action.type !== "create_agent" || action.keySource !== "generate_in_browser")
    throw new Error("The delivered key does not match the approved agent action.");

  const credentialId = `credential-${job.jobId}`;
  const profileId = `${job.host}-${job.jobId}`;
  const createdAt = new Date().toISOString();
  const credential: AgentCredential = {
    schemaVersion: 1,
    credentialId,
    agentPrivateKey: decrypted.agentPrivateKey,
    agentPubkey: decrypted.agentPubkey,
    createdAt,
  };
  const profile: AgentProfile = {
    schemaVersion: 1,
    profileId,
    credentialId,
    host: job.host,
    organization: action.organization,
    network: action.network,
    agentPubkey: decrypted.agentPubkey,
    serviceOrigin: job.serviceOrigin,
    createdAt,
  };
  await store.activate({ credential, profile });
  job.activatedProfileId = profileId;
  job.activatedAt = createdAt;
  job.keyDeliveryPrivateKeyPem = "destroyed-after-activation";
  job.sessionSecret = "consumed-after-activation";
  await store.saveJob(job);
  return profileId;
}

export async function continueControlJob(
  jobId: string,
  store = new ControlStore(),
  checkStatus: AgentStatusCheck = defaultStatusCheck,
): Promise<PublicJobView> {
  const job = await store.readJob(jobId);
  if (job.activatedProfileId) {
    return {
      schemaVersion: 1,
      jobId: job.jobId,
      host: job.host,
      purpose: job.purpose,
      status: "completed",
      verificationCode: job.verificationCode,
      verificationUri: job.verificationUri,
      expiresAt: job.expiresAt,
      nextAction: "DONE",
      agentStatus: await activeAgentStatus(checkStatus),
      message: `Profile ${job.activatedProfileId} is active for ${job.host}.`,
    };
  }
  const client = clientFor(job);
  const session = await client.getSession(job.sessionId, job.sessionSecret);
  const proposal = await client.getProposal(job.sessionId, job.sessionSecret);
  const execution = await client.getLatestExecution(job.sessionId, job.sessionSecret);
  if (!proposal || !execution) return view({ job, session, proposal, execution });
  if (execution.status === "needs_action") {
    return view({
      job,
      session,
      proposal,
      execution,
      message:
        "The approved setup partially completed. Review the failed step before starting a new approval.",
    });
  }
  if (execution.status !== "completed") return view({ job, session, proposal, execution });
  const profileId = await activateCompletedJob(job, proposal, execution, store);
  return view({
    job,
    session,
    proposal,
    execution,
    agentStatus: await activeAgentStatus(checkStatus),
    message: `Profile ${profileId} is active for ${job.host}.`,
  });
}

export async function cancelControlJob(
  jobId: string,
  store = new ControlStore(),
  client?: ControlClient,
): Promise<PublicJobView> {
  const job = await store.readJob(jobId);
  const api = client ?? clientFor(job);
  let status: SessionView["status"] = "cancelled";
  // Says what happened locally too, so the assistant can report the cleanup instead of assuming it.
  let message = "The pending authorization was cancelled. Its local data was removed.";
  try {
    await api.cancelSession(job.sessionId, job.sessionSecret);
  } catch (error) {
    // Atbash refuses to cancel a session that is no longer active. The local job
    // still holds the session secret and the key-delivery private key, so it is
    // removed anyway - unless the session completed: then that key is the only
    // way to open the new agent's delivered key, and deleting it would strand an
    // agent that already exists. Any other failure keeps the job for a retry.
    if (!(error instanceof ControlApiError) || error.status !== 404) throw error;
    status = await endedSessionStatus(api, job);
    message = "The setup session had already ended on Atbash. Its local data was removed.";
  }
  const session: SessionView = {
    id: job.sessionId,
    host: job.host,
    purpose: job.purpose,
    clientVersion: CONTROL_CLIENT_VERSION,
    status,
    identityBound: false,
    expiresAt: job.expiresAt,
  };
  const result = view({ job, session, message });
  await store.removeJob(job.jobId);
  return result;
}

/**
 * Why Atbash refused to cancel, as a status the local job may be removed for.
 * A session Atbash no longer knows (expired and cleaned up, or a secret already
 * consumed by activation) counts as ended.
 */
async function endedSessionStatus(
  api: Pick<ControlClient, "getSession" | "getLatestExecution">,
  job: PendingJob,
): Promise<SessionView["status"]> {
  let current: SessionView;
  try {
    current = await api.getSession(job.sessionId, job.sessionSecret);
  } catch (error) {
    if (error instanceof ControlApiError && error.status === 404) return "expired";
    throw error;
  }
  if (current.status === "completed" && !job.activatedProfileId) {
    const execution = await api.getLatestExecution(job.sessionId, job.sessionSecret);
    if (execution && execution.keyDeliveries.length > 0) {
      throw new Error(
        `This setup already completed on Atbash and delivered a new agent key that is not activated yet. Run "setup continue ${job.jobId}" to activate it instead of cancelling.`,
      );
    }
  }
  if (["cancelled", "rejected", "expired", "completed"].includes(current.status))
    return current.status;
  throw new Error("Atbash could not cancel this session yet. Try again.");
}
