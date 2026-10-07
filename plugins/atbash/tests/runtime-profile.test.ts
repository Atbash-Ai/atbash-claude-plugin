import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateKeypair } from "@atbash/sdk";
import { loadSelectedRuntimeProfile } from "../src/control/runtime-profile.js";
import { ControlStore } from "../src/control/store.js";

test("selected host profile resolves a matching local credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "atbash-runtime-profile-"));
  const keypair = generateKeypair();
  const store = new ControlStore(root);
  await store.activate({
    credential: {
      schemaVersion: 1,
      credentialId: "credential-one",
      agentPrivateKey: keypair.priv_key,
      agentPubkey: keypair.pub_key,
      createdAt: "2099-01-01T00:00:00.000Z",
    },
    profile: {
      schemaVersion: 1,
      profileId: "claude-one",
      credentialId: "credential-one",
      host: "claude",
      organization: "Acme",
      network: "public",
      agentPubkey: keypair.pub_key,
      serviceOrigin: "https://atbash.ai",
      createdAt: "2099-01-01T00:00:00.000Z",
    },
  });

  const previousRoot = process.env.ATBASH_CONFIG_DIR;
  const previousKey = process.env.ATBASH_AGENT_KEY;
  const previousOrg = process.env.ATBASH_ORG_NAME;
  process.env.ATBASH_CONFIG_DIR = root;
  delete process.env.ATBASH_AGENT_KEY;
  delete process.env.ATBASH_ORG_NAME;
  try {
    const profile = loadSelectedRuntimeProfile("claude");
    assert.equal(profile?.profileId, "claude-one");
    assert.equal(profile?.agentPubkey, keypair.pub_key);
    assert.equal(profile?.orgName, "Acme");
    assert.equal(profile?.agentKey, keypair.priv_key);

    process.env.ATBASH_ORG_NAME = "OtherOrg";
    assert.throws(() => loadSelectedRuntimeProfile("claude"), /conflicts/);
  } finally {
    if (previousRoot === undefined) delete process.env.ATBASH_CONFIG_DIR;
    else process.env.ATBASH_CONFIG_DIR = previousRoot;
    if (previousKey === undefined) delete process.env.ATBASH_AGENT_KEY;
    else process.env.ATBASH_AGENT_KEY = previousKey;
    if (previousOrg === undefined) delete process.env.ATBASH_ORG_NAME;
    else process.env.ATBASH_ORG_NAME = previousOrg;
  }
});
