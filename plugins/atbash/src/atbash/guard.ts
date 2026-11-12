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

/**
 * The SDK's decision, with the field a client-enforcing SDK adds when the organisation's mode let
 * a refused action run. Declared here because the production SDK's types do not carry it yet.
 */
export type GuardDecision = Decision & { wouldVerdict?: "BLOCK" | "HOLD" };

export interface ToolCallGuard {
  auditToolCall(input: ToolCallInput): Promise<GuardDecision>;
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

/** The organisation modes under which a verdict is recorded but not applied. */
const NON_ENFORCING_MODES: ReadonlySet<string> = new Set(["shadow", "monitor", "off"]);

/** The reason the SDK gives a call the judge recorded without judging yet (the fast acknowledgement). */
const RECORDED_UNJUDGED = /^Recorded in (?:shadow|monitor|off) mode\b/;

/**
 * A permit the organisation's enforcement mode granted, not the judge's verdict.
 *
 * The SDK applies the mode itself, and only a mode that arrived signed by the judge and bound to
 * this call: under `shadow`, `monitor` or `off` a BLOCK or HOLD runs and is reported in
 * `wouldVerdict`, and a call the judge only recorded (no verdict yet) runs at once. Nothing here
 * can turn a deny into a permit; it describes a permit the SDK already made, for the local log.
 */
export interface UnenforcedPermit {
  /** `shadow`, `monitor` or `off`; `unknown` when the decision names no mode. */
  mode: string;
  /** What the judge decided, when it had decided by the time the call was permitted. */
  wouldVerdict?: "BLOCK" | "HOLD";
  /** True when the call was recorded and permitted before the judge reached a verdict. */
  pending: boolean;
  reason: string;
  toolCallId?: string;
}

export function describeUnenforcedPermit(decision: GuardDecision): UnenforcedPermit | undefined {
  if (decision.allow !== true || decision.verdict !== "ALLOW") return undefined;
  const stated =
    typeof decision.enforcementMode === "string"
      ? decision.enforcementMode.trim().toLowerCase()
      : "";
  const mode = NON_ENFORCING_MODES.has(stated) ? stated : "unknown";
  const reason = typeof decision.reason === "string" ? decision.reason : "";
  const reference =
    typeof decision.toolCallId === "string" && decision.toolCallId.trim() !== ""
      ? { toolCallId: decision.toolCallId }
      : {};
  if (decision.wouldVerdict === "BLOCK" || decision.wouldVerdict === "HOLD") {
    return { mode, wouldVerdict: decision.wouldVerdict, pending: false, reason, ...reference };
  }
  if (mode !== "unknown" && RECORDED_UNJUDGED.test(reason)) {
    return { mode, pending: true, reason, ...reference };
  }
  return undefined;
}

export function createAtbashGuard(host: ControlHost = "claude"): ToolCallGuard {
  assertJudgeEndpointAllowed();
  const configuration = resolveGuardConfiguration(host);
  // The SDK collapses the judge's answer itself: the most restrictive of `verdict`, `action_type`
  // and `allow` wins, so an answer that does not grant `allow: true` is never a permit (the
  // wrapper that re-checked this for SDK 0.9.x is gone; the built-hook tests keep the case).
  // `requireEnforcement` refuses an answer that carries no enforcement decision at all, and the
  // organisation's mode relaxes a verdict only when the judge signed it for this call.
  return Atbash.fromConfig({
    failClosed: true,
    requireEnforcement: true,
    ...(configuration.agentKey ? { agentKey: configuration.agentKey } : {}),
    ...(configuration.orgName ? { orgName: configuration.orgName } : {}),
    timeoutMs: resolveTimeoutMs(),
  });
}
