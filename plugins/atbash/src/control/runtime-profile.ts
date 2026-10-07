import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { derivePublicKey, isValidPrivateKey } from "@atbash/sdk";
import type { ControlHost } from "./protocol.js";
import { configRoot, type AgentCredential, type AgentProfile } from "./store.js";

export interface RuntimeProfile {
  source: "profile";
  profileId: string;
  agentKey: string;
  agentPubkey: string;
  orgName: string;
  network: "public" | "private";
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value))
    throw new Error(`Invalid ${label}.`);
  return value;
}

function secureJson<T>(path: string): T {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Atbash profile state is not a regular file.");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    throw new Error("Atbash profile state has unsafe permissions.");
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function loadSelectedRuntimeProfile(host: ControlHost): RuntimeProfile | null {
  const root = configRoot();
  let selected: { schemaVersion?: unknown; profileId?: unknown };
  try {
    selected = secureJson(join(root, "hosts", `${host}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (selected.schemaVersion !== 1) throw new Error("Unsupported Atbash host profile version.");
  const profileId = safeId(selected.profileId, "profile identifier");
  const profile = secureJson<AgentProfile>(join(root, "profiles", `${profileId}.json`));
  const credentialId = safeId(profile.credentialId, "credential identifier");
  const credential = secureJson<AgentCredential>(join(root, "credentials", `${credentialId}.json`));
  if (
    profile.schemaVersion !== 1 ||
    credential.schemaVersion !== 1 ||
    profile.host !== host ||
    (profile.network !== "public" && profile.network !== "private") ||
    !isValidPrivateKey(credential.agentPrivateKey)
  )
    throw new Error("The selected Atbash profile is invalid.");

  const derived = derivePublicKey(credential.agentPrivateKey).toLowerCase();
  if (
    derived !== credential.agentPubkey.toLowerCase() ||
    derived !== profile.agentPubkey.toLowerCase()
  )
    throw new Error("The selected Atbash profile key does not match its public identity.");

  const envKey = process.env.ATBASH_AGENT_KEY?.trim();
  const envOrg = process.env.ATBASH_ORG_NAME?.trim();
  if (envKey && envKey.toLowerCase() !== credential.agentPrivateKey.toLowerCase())
    throw new Error("ATBASH_AGENT_KEY conflicts with the selected Atbash profile.");
  if (envOrg && envOrg !== profile.organization)
    throw new Error("ATBASH_ORG_NAME conflicts with the selected Atbash profile.");

  return {
    source: "profile",
    profileId,
    agentKey: credential.agentPrivateKey,
    agentPubkey: derived,
    orgName: profile.organization,
    network: profile.network,
  };
}
