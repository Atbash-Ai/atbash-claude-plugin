import { Atbash, type AgentPolicy } from "@atbash/sdk";

import { resolveGuardConfiguration, resolveTimeoutMs } from "./guard.js";

export interface StatusConfiguration {
  source: "profile" | "legacy";
  profileId?: string;
  organization?: string;
  network?: "public" | "private";
}

export type AtbashStatus =
  | {
      ready: true;
      state: "ready";
      pubkey: string;
      policy: AgentPolicy;
      configuration?: StatusConfiguration;
    }
  | {
      ready: false;
      state: "configuration_error" | "agent_not_registered" | "agent_jailed" | "service_error";
      message: string;
      pubkey?: string;
      policy?: AgentPolicy;
      configuration?: StatusConfiguration;
    };

export interface StatusClient {
  readonly pubkey: string;
  readonly configuration?: StatusConfiguration;
  checkAgentExists(): Promise<boolean>;
  getAgentPolicy(pubkey: string): Promise<AgentPolicy>;
}

export type StatusClientFactory = () => StatusClient;

function createStatusClient(): StatusClient {
  const configuration = resolveGuardConfiguration("claude");
  const client = Atbash.fromConfig({
    failClosed: true,
    ...(configuration.agentKey ? { agentKey: configuration.agentKey } : {}),
    ...(configuration.orgName ? { orgName: configuration.orgName } : {}),
    timeoutMs: resolveTimeoutMs(),
  });
  const statusConfiguration: StatusConfiguration = {
    source: configuration.source,
    ...(configuration.profileId ? { profileId: configuration.profileId } : {}),
    ...(configuration.orgName ? { organization: configuration.orgName } : {}),
    ...(configuration.network ? { network: configuration.network } : {}),
  };
  return {
    pubkey: client.pubkey,
    configuration: statusConfiguration,
    checkAgentExists: () => client.checkAgentExists(),
    getAgentPolicy: (pubkey) => client.getAgentPolicy(pubkey),
  };
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
        ...(client.configuration ? { configuration: client.configuration } : {}),
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
        ...(client.configuration ? { configuration: client.configuration } : {}),
      };
    }

    return {
      ready: true,
      state: "ready",
      pubkey: client.pubkey,
      policy,
      ...(client.configuration ? { configuration: client.configuration } : {}),
    };
  } catch {
    return {
      ready: false,
      state: "service_error",
      message: "Atbash status could not be retrieved.",
      pubkey: client.pubkey,
      ...(client.configuration ? { configuration: client.configuration } : {}),
    };
  }
}
