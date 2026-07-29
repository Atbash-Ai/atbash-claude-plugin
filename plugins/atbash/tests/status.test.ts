import assert from "node:assert/strict";
import test from "node:test";

import type { AgentPolicy } from "@atbash/sdk";

import { getAtbashStatus, type StatusClient } from "../src/atbash/status.js";

const activePolicy: AgentPolicy = {
  policy: "allow safe development actions",
  isJailed: false,
  isCustom: true,
  defaultPolicy: "default",
};

function statusClient(overrides: Partial<StatusClient> = {}): StatusClient {
  return {
    pubkey: "pubkey-test",
    async checkAgentExists() {
      return true;
    },
    async getAgentPolicy() {
      return activePolicy;
    },
    ...overrides,
  };
}

test("reports a ready configured agent", async () => {
  assert.deepEqual(await getAtbashStatus(() => statusClient()), {
    ready: true,
    state: "ready",
    pubkey: "pubkey-test",
    policy: activePolicy,
  });
});

test("reports configuration, registration, jailed, and service failures safely", async () => {
  const configuration = await getAtbashStatus(() => {
    throw new Error("private-key-value");
  });
  const missing = await getAtbashStatus(() =>
    statusClient({
      async checkAgentExists() {
        return false;
      },
    }),
  );
  const jailedPolicy = { ...activePolicy, isJailed: true };
  const jailed = await getAtbashStatus(() =>
    statusClient({
      async getAgentPolicy() {
        return jailedPolicy;
      },
    }),
  );
  const service = await getAtbashStatus(() =>
    statusClient({
      async checkAgentExists() {
        throw new Error("service-secret");
      },
    }),
  );

  assert.equal(configuration.state, "configuration_error");
  assert.equal(missing.state, "agent_not_registered");
  assert.equal(jailed.state, "agent_jailed");
  assert.equal(service.state, "service_error");
  assert.doesNotMatch(JSON.stringify([configuration, service]), /private-key-value|service-secret/);
});
