export type ControlHost = "codex" | "claude";
export type ControlPurpose = "onboard" | "manage";
export type ControlNetwork = "public" | "private";
export type SessionStatus =
  | "pending_identity"
  | "identity_bound"
  | "drafting"
  | "awaiting_approval"
  | "approved"
  | "executing"
  | "needs_action"
  | "completed"
  | "cancelled"
  | "rejected"
  | "expired";

export interface KeyDeliveryPublicKey {
  kty: "RSA";
  alg: "RSA-OAEP-256";
  n: string;
  e: "AQAB";
  ext: true;
  key_ops: ["encrypt"];
}

export interface CreatedSession {
  sessionId: string;
  sessionSecret: string;
  verificationCode: string;
  verificationUri: string;
  status: SessionStatus;
  expiresAt: string;
  pollIntervalMs: number;
}

export interface SessionView {
  id: string;
  host: ControlHost;
  purpose: ControlPurpose;
  clientVersion: string;
  deviceName?: string;
  status: SessionStatus;
  identityBound: boolean;
  expiresAt: string;
}

export interface SetupInventory {
  authoritative: boolean;
  setupState:
    "needs_account" | "needs_organization" | "needs_agent" | "ready_existing" | "retry_discovery";
  hasAtbashAccount: boolean;
  accounts: Array<{ network: ControlNetwork }>;
  organizations: Array<{ name: string; network: ControlNetwork; active: boolean }>;
  agents: Array<{
    pubkey: string;
    organization: string;
    network: ControlNetwork;
    name: string;
    purpose: string;
    risk: string;
    active: boolean;
    jailed: boolean;
  }>;
  unavailableNetworks: ControlNetwork[];
}

export type ProposalAction =
  | { type: "create_account"; network: ControlNetwork }
  | { type: "create_organization"; network: ControlNetwork; name: string; description: string }
  | { type: "activate_free_plan"; network: "public"; organization: string }
  | {
      type: "create_agent";
      network: ControlNetwork;
      organization: string;
      name: string;
      purpose: string;
      risk: "low" | "medium" | "high" | "critical";
      keySource: "generate_in_browser" | "local_public_key";
      agentPubkey?: string;
    }
  | {
      type: "update_agent";
      network: ControlNetwork;
      organization: string;
      agentPubkey: string;
      changes: {
        name?: string;
        purpose?: string;
        risk?: "low" | "medium" | "high" | "critical";
        active?: boolean;
      };
    };

export interface ProposalView {
  id: string;
  sessionId: string;
  revision: number;
  proposalHash: string;
  actions: ProposalAction[];
  status: "awaiting_approval" | "approved" | "rejected" | "expired" | "superseded" | "consumed";
  expiresAt: string;
  createdAt: string;
}

export interface ExecutionResult {
  actionIndex: number;
  type: ProposalAction["type"];
  status: "completed" | "failed";
  transactionRid?: string;
  agentPubkey?: string;
  message?: string;
}

export interface EncryptedKeyDelivery {
  version: 1;
  algorithm: "RSA-OAEP-256";
  ciphertext: string;
  label: string;
  agentPubkey: string;
}

export interface ExecutionView {
  id: string;
  sessionId: string;
  proposalId: string;
  proposalHash: string;
  status: "executing" | "completed" | "needs_action";
  results: ExecutionResult[];
  keyDeliveries: EncryptedKeyDelivery[];
  claimedAt: string;
  completedAt?: string;
}

export interface PublicJobView {
  schemaVersion: 1;
  jobId: string;
  host: ControlHost;
  purpose: ControlPurpose;
  status: SessionStatus;
  verificationCode: string;
  verificationUri: string;
  expiresAt: string;
  nextAction:
    | "OPEN_BROWSER"
    | "PREPARE_PLAN"
    | "REVIEW_IN_BROWSER"
    | "WAIT"
    | "ACTIVATE"
    | "RECOVER"
    | "DONE";
  discovery?: SetupInventory;
  proposal?: ProposalView;
  execution?: ExecutionView;
  message?: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label} response.`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Invalid ${label} response.`);
  return value;
}

export function parseCreatedSession(value: unknown): CreatedSession {
  const row = record(value, "session");
  const pollIntervalMs = Number(row.pollIntervalMs);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 500 || pollIntervalMs > 30_000) {
    throw new Error("Invalid session polling interval.");
  }
  const hostless = {
    sessionId: string(row.sessionId, "session"),
    sessionSecret: string(row.sessionSecret, "session"),
    verificationCode: string(row.verificationCode, "session"),
    verificationUri: string(row.verificationUri, "session"),
    status: string(row.status, "session") as SessionStatus,
    expiresAt: string(row.expiresAt, "session"),
    pollIntervalMs,
  };
  if (!/^https?:\/\//.test(hostless.verificationUri))
    throw new Error("Invalid session verification URL.");
  return hostless;
}

export function parseSessionView(value: unknown): SessionView {
  const row = record(value, "session");
  if (row.host !== "codex" && row.host !== "claude") throw new Error("Invalid session host.");
  if (row.purpose !== "onboard" && row.purpose !== "manage")
    throw new Error("Invalid session purpose.");
  if (typeof row.identityBound !== "boolean") throw new Error("Invalid session identity state.");
  return {
    id: string(row.id, "session"),
    host: row.host,
    purpose: row.purpose,
    clientVersion: string(row.clientVersion, "session"),
    ...(typeof row.deviceName === "string" ? { deviceName: row.deviceName } : {}),
    status: string(row.status, "session") as SessionStatus,
    identityBound: row.identityBound,
    expiresAt: string(row.expiresAt, "session"),
  };
}

export function parseResources(value: unknown): {
  session: SessionView;
  discovery: SetupInventory | null;
} {
  const row = record(value, "resources");
  return {
    session: parseSessionView(row.session),
    discovery:
      row.discovery === null
        ? null
        : (record(row.discovery, "discovery") as unknown as SetupInventory),
  };
}

export function parseProposalEnvelope(value: unknown): {
  session: SessionView;
  proposal: ProposalView | null;
} {
  const row = record(value, "proposal");
  return {
    session: parseSessionView(row.session),
    proposal:
      row.proposal === null ? null : (record(row.proposal, "proposal") as unknown as ProposalView),
  };
}

export function parseExecutionEnvelope(value: unknown): {
  session: SessionView;
  execution: ExecutionView | null;
} {
  const row = record(value, "execution");
  return {
    session: parseSessionView(row.session),
    execution:
      row.execution === null
        ? null
        : (record(row.execution, "execution") as unknown as ExecutionView),
  };
}
