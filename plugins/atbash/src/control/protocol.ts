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
  execution?: Omit<ExecutionView, "keyDeliveries"> & { keyDeliveryCount: number };
  message?: string;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Plan contains unknown fields.");
}

function network(value: unknown): ControlNetwork {
  if (value !== "public" && value !== "private")
    throw new Error("Plan network must be public or private.");
  return value;
}

function planText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > max ||
    Array.from(normalized).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  )
    throw new Error(`${label} is invalid.`);
  return normalized;
}

function risk(value: unknown): "low" | "medium" | "high" | "critical" {
  if (value !== "low" && value !== "medium" && value !== "high" && value !== "critical")
    throw new Error("Agent risk must be low, medium, high, or critical.");
  return value;
}

function parseAction(value: unknown): ProposalAction {
  const row = record(value, "plan action");
  if (row.type === "create_account") {
    exactKeys(row, ["type", "network"]);
    return { type: row.type, network: network(row.network) };
  }
  if (row.type === "create_organization") {
    exactKeys(row, ["type", "network", "name", "description"]);
    return {
      type: row.type,
      network: network(row.network),
      name: planText(row.name, "Organization name", 64),
      description: planText(row.description, "Organization description", 280),
    };
  }
  if (row.type === "activate_free_plan") {
    exactKeys(row, ["type", "network", "organization"]);
    if (row.network !== "public")
      throw new Error("The Free plan is available only on the public network.");
    return {
      type: row.type,
      network: row.network,
      organization: planText(row.organization, "Organization", 64),
    };
  }
  if (row.type === "create_agent") {
    exactKeys(row, [
      "type",
      "network",
      "organization",
      "name",
      "purpose",
      "risk",
      "keySource",
      "agentPubkey",
    ]);
    if (row.keySource !== "generate_in_browser" && row.keySource !== "local_public_key")
      throw new Error("Agent keySource is invalid.");
    const agentPubkey =
      row.agentPubkey === undefined ? undefined : planText(row.agentPubkey, "Agent public key", 68);
    if (row.keySource === "local_public_key" && !/^(02|03)[0-9a-f]{64}$/i.test(agentPubkey ?? ""))
      throw new Error("A valid local agent public key is required.");
    if (row.keySource === "generate_in_browser" && agentPubkey !== undefined)
      throw new Error("A browser-generated agent cannot include a public key.");
    return {
      type: row.type,
      network: network(row.network),
      organization: planText(row.organization, "Organization", 64),
      name: planText(row.name, "Agent name", 80),
      purpose: planText(row.purpose, "Agent purpose", 280),
      risk: risk(row.risk),
      keySource: row.keySource,
      ...(agentPubkey ? { agentPubkey: agentPubkey.toLowerCase() } : {}),
    };
  }
  if (row.type === "update_agent") {
    exactKeys(row, ["type", "network", "organization", "agentPubkey", "changes"]);
    const changesRow = record(row.changes, "agent changes");
    exactKeys(changesRow, ["name", "purpose", "risk", "active"]);
    if (Object.keys(changesRow).length === 0) throw new Error("Agent changes cannot be empty.");
    const pubkey = planText(row.agentPubkey, "Agent public key", 68).toLowerCase();
    if (!/^(02|03)[0-9a-f]{64}$/.test(pubkey)) throw new Error("Agent public key is invalid.");
    if (changesRow.active !== undefined && typeof changesRow.active !== "boolean")
      throw new Error("Agent active must be true or false.");
    return {
      type: row.type,
      network: network(row.network),
      organization: planText(row.organization, "Organization", 64),
      agentPubkey: pubkey,
      changes: {
        ...(changesRow.name === undefined
          ? {}
          : { name: planText(changesRow.name, "Agent name", 80) }),
        ...(changesRow.purpose === undefined
          ? {}
          : { purpose: planText(changesRow.purpose, "Agent purpose", 280) }),
        ...(changesRow.risk === undefined ? {} : { risk: risk(changesRow.risk) }),
        ...(changesRow.active === undefined ? {} : { active: changesRow.active }),
      },
    };
  }
  throw new Error("Plan contains an unsupported action.");
}

export function parseProposalActions(value: unknown): ProposalAction[] {
  const envelope = record(value, "plan");
  exactKeys(envelope, ["actions"]);
  if (
    !Array.isArray(envelope.actions) ||
    envelope.actions.length < 1 ||
    envelope.actions.length > 10
  )
    throw new Error("Plan must contain between 1 and 10 actions.");
  const actions = envelope.actions.map(parseAction);
  if (actions.filter((action) => action.type === "create_account").length > 1)
    throw new Error("A plan can create at most one account.");
  if (actions.filter((action) => action.type === "create_organization").length > 1)
    throw new Error("A plan can create at most one organization.");
  if (actions.filter((action) => action.type === "activate_free_plan").length > 1)
    throw new Error("A plan can activate the Free plan at most once.");
  if (new Set(actions.map((action) => action.network)).size !== 1)
    throw new Error("All plan actions must target the same network.");
  const rank: Record<ProposalAction["type"], number> = {
    create_account: 0,
    create_organization: 1,
    activate_free_plan: 2,
    create_agent: 3,
    update_agent: 3,
  };
  if (
    actions.some((action, index) => index > 0 && rank[action.type] < rank[actions[index - 1]!.type])
  )
    throw new Error("Plan actions must follow onboarding execution order.");
  return actions;
}

export function validateProposalActionsForPurpose(
  actions: ProposalAction[],
  purpose: ControlPurpose,
): void {
  if (purpose === "onboard") {
    const createdAgents = actions.filter((action) => action.type === "create_agent");
    if (
      createdAgents.length !== 1 ||
      createdAgents[0]?.type !== "create_agent" ||
      createdAgents[0].keySource !== "generate_in_browser" ||
      actions.some((action) => action.type === "update_agent")
    ) {
      throw new Error(
        "An onboarding plan must create exactly one browser-generated agent and cannot update agents.",
      );
    }
    return;
  }
  if (actions.length !== 1 || actions[0]?.type !== "update_agent")
    throw new Error("A management plan must contain exactly one agent update.");
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
