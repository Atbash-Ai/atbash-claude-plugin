import { Atbash, type AgentPolicy } from "@atbash/sdk";

import { resolveOrgName, resolveTimeoutMs } from "./guard.js";

export type AtbashStatus =
  | {
      ready: true;
      state: "ready";
      pubkey: string;
      policy: AgentPolicy;
    }
  | {
      ready: false;
      state: "configuration_error" | "agent_not_registered" | "agent_jailed" | "service_error";
      message: string;
      pubkey?: string;
      policy?: AgentPolicy;
    };

export interface StatusClient {
  readonly pubkey: string;
  checkAgentExists(): Promise<boolean>;
  getAgentPolicy(pubkey: string): Promise<AgentPolicy>;
}

export type StatusClientFactory = () => StatusClient;

function createStatusClient(): StatusClient {
  const orgName = resolveOrgName();
  return Atbash.fromConfig({
    failClosed: true,
    ...(orgName === undefined ? {} : { orgName }),
    timeoutMs: resolveTimeoutMs(),
  });
}

export async function getAtbashStatus(
  createClient: StatusClientFactory = createStatusClient,
): Promise<AtbashStatus> {
  let client: StatusClient;
  try {
    client = createClient();
  } catch {
    return {
      ready: false,
      state: "configuration_error",
      message: "Atbash configuration is missing or invalid.",
    };
  }

  try {
    if (!(await client.checkAgentExists())) {
      return {
        ready: false,
        state: "agent_not_registered",
        message: "The configured Atbash agent is not registered.",
        pubkey: client.pubkey,
      };
    }

    const policy = await client.getAgentPolicy(client.pubkey);
    if (policy.isJailed) {
      return {
        ready: false,
        state: "agent_jailed",
        message: "The configured Atbash agent is jailed.",
        pubkey: client.pubkey,
        policy,
      };
    }

    return {
      ready: true,
      state: "ready",
      pubkey: client.pubkey,
      policy,
    };
  } catch {
    return {
      ready: false,
      state: "service_error",
      message: "Atbash status could not be retrieved.",
      pubkey: client.pubkey,
    };
  }
}
