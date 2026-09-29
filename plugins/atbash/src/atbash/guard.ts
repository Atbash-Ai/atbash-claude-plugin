import { Atbash, resolve, type Decision, type ToolCallInput } from "@atbash/sdk";

export const DEFAULT_ATBASH_TIMEOUT_MS = 30_000;
export const MIN_ATBASH_TIMEOUT_MS = 1_000;
export const MAX_ATBASH_TIMEOUT_MS = 30_000;

export interface ToolCallGuard {
  auditToolCall(input: ToolCallInput): Promise<Decision>;
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

/** The developer switch for a local judge. Read from the hook's own environment only. */
export const LOCAL_JUDGE_FLAG = "ATBASH_DEV_ALLOW_LOCAL_JUDGE";

/** A configuration problem whose reason is safe to show the user. */
export class GuardConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardConfigError";
  }
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\./.test(host) ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    /^(0+:){7}0*1$/.test(host) ||
    /^::ffff:(127\.|7f)/.test(host)
  );
}

/**
 * Refuse a judge endpoint that is loopback or not https unless the developer flag is set in the
 * hook's environment AND a response-signing key is configured. The SDK accepts http://localhost
 * with no key, so a process on this machine could otherwise answer ALLOW to every call: an agent
 * that can write ~/.config/atbash/config.json and start a server would switch enforcement off. The
 * flag is read from the environment only (never the config file an agent could write), and the key
 * makes the SDK verify every verdict's signature, so a planted endpoint alone gets nothing.
 */
export function assertJudgeEndpointAllowed(
  endpoint: string = resolve("judgeEndpoint"),
  verifyPubKey: string = resolve("judgeVerifyPubKey"),
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
  if (url.protocol === "https:" && !isLocalHost(url.hostname)) return;
  const flag = env[LOCAL_JUDGE_FLAG] === "1";
  const key = /^(0x)?[0-9a-f]{66}$/i.test(verifyPubKey.trim());
  if (!flag || !key) {
    throw new GuardConfigError(
      `Atbash ERROR: the judge endpoint is local or not https. A local judge needs ${LOCAL_JUDGE_FLAG}=1 in the hook's environment and its response-signing key in ATBASH_JUDGE_VERIFY_PUBKEY.`,
    );
  }
}

export function createAtbashGuard(): ToolCallGuard {
  assertJudgeEndpointAllowed();
  const orgName = resolveOrgName();
  return Atbash.fromConfig({
    failClosed: true,
    ...(orgName === undefined ? {} : { orgName }),
    timeoutMs: resolveTimeoutMs(),
  });
}
