/**
 * Opt-in session context: the user's latest request and the last few tool
 * steps of this Claude Code session, redacted and size-capped, for the Atbash
 * judge to tell whether an action is what the user asked for.
 *
 * NOT SENT YET. The payload must travel in its own judge request field
 * (`session_context` plus `session_context_nonce`), never in the signed
 * `context`, which is written to the Chromia chain. The SDK's judge call has no
 * such field today, so the hook does not call this module and the signed
 * context stays the four host facts from `hook/context.ts`. See the README
 * section "Session context (opt-in, not yet active)".
 */
import { createHash, randomBytes } from "node:crypto";

import { loadUserConfig, redactSecrets } from "@atbash/sdk";

import type { PreToolUseInput } from "../hook/protocol.js";
import { containsSessionSecret, redactSessionText } from "./redact.js";
import {
  extractTranscript,
  readTranscriptTail,
  transcriptRoot,
  type TranscriptStep,
} from "./transcript.js";

export const SHARE_SESSION_CONTEXT_ENV = "ATBASH_SHARE_SESSION_CONTEXT";
export const SHARE_SESSION_CONTEXT_CONFIG_KEY = "shareSessionContext";

/** Total payload ceiling, in characters. */
export const SESSION_CONTEXT_MAX_CHARS = 4000;
export const MAX_STEPS = 5;
export const USER_REQUEST_MAX_CHARS = 1500;
export const STEP_INPUT_MAX_CHARS = 300;
export const STEP_RESULT_MAX_CHARS = 400;
/** Raw text examined per item before redaction; bounds the regex work. */
const RAW_WINDOW_FACTOR = 4;

/** Name of the fact that binds the signed context to the separate payload. */
export const SESSION_CONTEXT_HASH_FACT = "session_context_sha256";

const ON = new Set(["1", "true", "yes", "on"]);
const OFF = new Set(["0", "false", "no", "off"]);

/**
 * Off unless the user opted in. The environment variable wins in both
 * directions; otherwise `shareSessionContext: true` in the Atbash SDK config
 * file (`~/.config/atbash/config.json`) turns it on. Anything unrecognised,
 * and any error reading the config, means off.
 */
export function resolveShareSessionContext(
  env: NodeJS.ProcessEnv = process.env,
  readConfig: () => unknown = loadUserConfig,
): boolean {
  try {
    const raw = env[SHARE_SESSION_CONTEXT_ENV]?.trim().toLowerCase();
    if (raw !== undefined && raw !== "") {
      return ON.has(raw) && !OFF.has(raw);
    }
    const config = readConfig();
    if (typeof config !== "object" || config === null) {
      return false;
    }
    const value = (config as Record<string, unknown>)[SHARE_SESSION_CONTEXT_CONFIG_KEY];
    return value === true || (typeof value === "string" && ON.has(value.trim().toLowerCase()));
  } catch {
    return false;
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * One transcript item as a single line of redacted, clipped text. Control
 * characters and line breaks become spaces, so transcript text cannot start a
 * line of its own and imitate a section label.
 */
function cleanItem(raw: string, max: number): string {
  const window = raw.slice(0, max * RAW_WINDOW_FACTOR);
  // eslint-disable-next-line no-control-regex
  const flattened = window
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSessionText(redactSecrets(flattened).redacted);
  // Again after clipping: a cut can leave a label whose value is a fragment.
  return redactSessionText(clip(redacted, max));
}

function formatStep(index: number, step: TranscriptStep): string {
  const input = cleanItem(step.input, STEP_INPUT_MAX_CHARS);
  const result =
    step.result === undefined
      ? "(no result)"
      : `${step.isError === true ? "(error) " : ""}${cleanItem(step.result, STEP_RESULT_MAX_CHARS)}`;
  return `${index}. tool=${cleanItem(step.name, 100)} input=${input} result=${result}`;
}

/**
 * Assemble the payload. The user request comes first, then the steps oldest to
 * newest. Over the cap, the oldest steps are dropped first; if the request
 * alone is still too long, it is clipped.
 */
export function formatSessionContext(
  userRequest: string | undefined,
  steps: readonly TranscriptStep[],
): string {
  const requestLine = `user_request: ${
    userRequest === undefined ? "(none)" : cleanItem(userRequest, USER_REQUEST_MAX_CHARS)
  }`;
  const recent = steps.slice(-MAX_STEPS);
  for (let drop = 0; drop <= recent.length; drop += 1) {
    const kept = recent.slice(drop);
    const lines = [requestLine, "recent_steps:", ...kept.map((step, i) => formatStep(i + 1, step))];
    if (kept.length === 0) {
      lines[1] = "recent_steps: (none)";
      lines.length = 2;
    }
    const text = lines.join("\n");
    if (text.length <= SESSION_CONTEXT_MAX_CHARS) {
      return text;
    }
  }
  return clip(`${requestLine}\nrecent_steps: (none)`, SESSION_CONTEXT_MAX_CHARS);
}

export interface SessionContextPayload {
  /** Redacted, capped text for the separate `session_context` request field. */
  sessionContext: string;
  /** 16 random bytes, lowercase hex, for `session_context_nonce`. */
  nonceHex: string;
  /** SHA-256 over the raw nonce bytes followed by the UTF-8 payload, lowercase hex. */
  sha256Hex: string;
}

export function bindSessionContext(
  sessionContext: string,
  nonce: Buffer = randomBytes(16),
): SessionContextPayload {
  const sha256Hex = createHash("sha256")
    .update(Buffer.concat([nonce, Buffer.from(sessionContext, "utf8")]))
    .digest("hex");
  return { sessionContext, nonceHex: nonce.toString("hex"), sha256Hex };
}

/** The fact appended to the signed context when a payload is sent. */
export function sessionContextHashFact(sha256Hex: string): string {
  return `${SESSION_CONTEXT_HASH_FACT}=${sha256Hex}`;
}

export interface SessionContextOptions {
  env?: NodeJS.ProcessEnv;
  readConfig?: () => unknown;
}

/**
 * The session context for one hook call, or undefined when the setting is off
 * or anything goes wrong. The transcript is not touched when the setting is
 * off. Undefined means "send today's four facts only"; it never allows or
 * blocks anything by itself. Never throws.
 */
export async function buildSessionContext(
  input: PreToolUseInput,
  options: SessionContextOptions = {},
): Promise<SessionContextPayload | undefined> {
  try {
    const env = options.env ?? process.env;
    if (!resolveShareSessionContext(env, options.readConfig)) {
      return undefined;
    }
    const jsonl = await readTranscriptTail(input.transcript_path, transcriptRoot(env));
    if (jsonl === undefined) {
      return undefined;
    }
    const { userRequest, steps } = extractTranscript(jsonl);
    // The pending call can already be in the transcript; it is the action
    // being judged, not an earlier step.
    const earlier = steps.filter(
      (step) => input.tool_use_id === undefined || step.id !== input.tool_use_id,
    );
    if (userRequest === undefined && earlier.length === 0) {
      return undefined;
    }
    const sessionContext = formatSessionContext(userRequest, earlier);
    // Last gate: a payload any rule still flags is not shared at all.
    if (containsSessionSecret(sessionContext)) {
      return undefined;
    }
    return bindSessionContext(sessionContext);
  } catch {
    return undefined;
  }
}
