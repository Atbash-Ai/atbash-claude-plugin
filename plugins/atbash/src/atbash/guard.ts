import {
  Atbash,
  buildAllowedJudgeHosts,
  resolve,
  type Decision,
  type ToolCallInput,
} from "@atbash/sdk";
import type { ControlHost } from "../control/protocol.js";
import { loadSelectedRuntimeProfile } from "../control/runtime-profile.js";

export const DEFAULT_ATBASH_TIMEOUT_MS = 30_000;
export const MIN_ATBASH_TIMEOUT_MS = 1_000;
export const MAX_ATBASH_TIMEOUT_MS = 30_000;

export interface ToolCallGuard {
  auditToolCall(input: ToolCallInput): Promise<Decision>;
}

export interface GuardConfiguration {
  source: "profile" | "legacy";
  agentKey?: string;
  orgName?: string;
  profileId?: string;
  agentPubkey?: string;
  network?: "public" | "private";
}

export function resolveOrgName(rawValue = resolve("orgName")): string | undefined {
  const orgName = rawValue.trim();
  return orgName === "" ? undefined : orgName;
}

export function resolveTimeoutMs(rawValue = process.env.ATBASH_HOOK_TIMEOUT_MS): number {
  if (rawValue === undefined || rawValue.trim() === "") {
    return DEFAULT_ATBASH_TIMEOUT_MS;
  }

  const parsed = Number(rawValue);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_ATBASH_TIMEOUT_MS ||
    parsed > MAX_ATBASH_TIMEOUT_MS
  ) {
    throw new Error(
      `ATBASH_HOOK_TIMEOUT_MS must be an integer between ${MIN_ATBASH_TIMEOUT_MS} and ${MAX_ATBASH_TIMEOUT_MS}.`,
    );
  }

  return parsed;
}

export function resolveGuardConfiguration(host: ControlHost = "claude"): GuardConfiguration {
  const profile = loadSelectedRuntimeProfile(host);
  if (profile) {
    return {
      source: "profile",
      agentKey: profile.agentKey,
      orgName: profile.orgName,
      profileId: profile.profileId,
      agentPubkey: profile.agentPubkey,
      network: profile.network,
    };
  }
  const orgName = resolveOrgName();
  return { source: "legacy", ...(orgName === undefined ? {} : { orgName }) };
}

/** The developer switch for a local judge. Read from the hook's own environment only. */
export const LOCAL_JUDGE_FLAG = "ATBASH_DEV_ALLOW_LOCAL_JUDGE";

/** A configuration problem whose reason is safe to show the user. */
export class GuardConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardConfigError";
  }
}

/** Atbash's own judge hosts, as the SDK lists them (atbash.ai, www.atbash.ai, the default's host). */
function isAtbashJudge(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    buildAllowedJudgeHosts().has(url.hostname.toLowerCase())
  );
}

const REFUSED = `Atbash ERROR: the judge endpoint is not Atbash's own. A local or self-hosted judge is accepted only from the hook's environment: ATBASH_ENDPOINT, its 66-hex response-signing key in ATBASH_JUDGE_VERIFY_PUBKEY, and ${LOCAL_JUDGE_FLAG}=1 - never from the config file.`;

/**
 * Accept only Atbash's own judge, unless the hook's ENVIRONMENT names another one together with its
 * response-signing key and the developer flag.
 *
 * The SDK accepts `http://localhost` with no key, and any https host once a verify key is set - and
 * both may come from `~/.config/atbash/config.json`, a file an agent can write. So a planted
 * `judgeEndpoint` (a local server, or the attacker's own https judge with the attacker's own key)
 * would answer ALLOW to every call. Here, an endpoint that is not one of Atbash's hosts over https
 * is refused unless ATBASH_ENDPOINT itself names it (the config file's value is never enough),
 * ATBASH_JUDGE_VERIFY_PUBKEY holds a well-formed key (so the SDK verifies every verdict), and
 * ATBASH_DEV_ALLOW_LOCAL_JUDGE=1. Nothing about the host name is trusted: `localhost.`, a loopback
 * DNS name or a decimal IP is simply "not Atbash's own".
 */
export function assertJudgeEndpointAllowed(
  endpoint: string = resolve("judgeEndpoint"),
  env: NodeJS.ProcessEnv = process.env,
): void {
  const raw = endpoint.trim();
  if (raw === "") return;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GuardConfigError("Atbash ERROR: the configured judge endpoint is not a valid URL.");
  }
  if (isAtbashJudge(url)) return;
  const fromEnv = (env.ATBASH_ENDPOINT ?? "").trim() === raw;
  // The SDK lower-cases and trims the key and accepts exactly 66 hex digits, no 0x prefix.
  const key = /^[0-9a-f]{66}$/i.test((env.ATBASH_JUDGE_VERIFY_PUBKEY ?? "").trim());
  const flag = env[LOCAL_JUDGE_FLAG] === "1";
  if (!fromEnv || !key || !flag) throw new GuardConfigError(REFUSED);
}

type JudgeActionFn = Atbash["judgeAction"];

/**
 * A permit needs the judge's own `allow === true`, not only the SDK's mapping of it.
 *
 * SDK 0.9.1's `auditToolCall` returns `{ allow: true, verdict: "ALLOW" }` from its
 * `action_type === "allow"` branch without consulting the judge's `allow` field, so a judge answer
 * of `{ verdict: "ALLOW", action_type: "allow", allow: false }` was a permit even though the SDK's
 * own `canonicalAllow` says no. The raw judgment (`JudgeResult.allow`, which is `canonicalAllow`)
 * is observed here on the client that makes the call, for this call only, and a permit without it
 * is an ERROR deny. If a future SDK stops routing through `judgeAction`, nothing is observed and
 * every permit is denied - fail closed, and a test says so.
 */
export function requireJudgeAllow(client: Atbash): ToolCallGuard {
  return {
    async auditToolCall(input: ToolCallInput): Promise<Decision> {
      const judged: unknown[] = [];
      const original: JudgeActionFn = client.judgeAction;
      client.judgeAction = async function (this: unknown, ...args: Parameters<JudgeActionFn>) {
        const result = await original.apply(client, args);
        judged.push(result);
        return result;
      };
      let decision: Decision;
      try {
        decision = await client.auditToolCall(input);
      } finally {
        client.judgeAction = original;
      }
      if (decision.allow !== true || decision.verdict !== "ALLOW") return decision;
      const [only, ...more] = judged;
      const judgeAllowed =
        more.length === 0 &&
        typeof only === "object" &&
        only !== null &&
        (only as { allow?: unknown }).allow === true;
      if (judgeAllowed) return decision;
      return {
        allow: false,
        verdict: "ERROR",
        reason: "the judge's answer did not grant permission (allow was not true)",
        ...(decision.toolCallId === undefined ? {} : { toolCallId: decision.toolCallId }),
      };
    },
  };
}

export function createAtbashGuard(host: ControlHost = "claude"): ToolCallGuard {
  assertJudgeEndpointAllowed();
  const configuration = resolveGuardConfiguration(host);
  return requireJudgeAllow(
    Atbash.fromConfig({
      failClosed: true,
      ...(configuration.agentKey ? { agentKey: configuration.agentKey } : {}),
      ...(configuration.orgName ? { orgName: configuration.orgName } : {}),
      timeoutMs: resolveTimeoutMs(),
    }),
  );
}
