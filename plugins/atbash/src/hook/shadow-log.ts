import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";

import type { UnenforcedPermit } from "../atbash/guard.js";
import { configRoot } from "../control/store.js";
import { sanitizeReason } from "./protocol.js";

/**
 * The local record of calls the organisation's enforcement mode let through: one line per call
 * that would have been blocked or held under enforcement, or that ran before the judge had
 * decided. It lives in the Atbash configuration directory, which self-protection keeps the agent
 * out of, and is readable by the user only.
 */
export const SHADOW_LOG_NAME = "shadow.log";

/** Past this size the log is moved to `shadow.log.1` (replacing the previous one) and restarted. */
export const MAX_SHADOW_LOG_BYTES = 1_048_576;

export function shadowLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configRoot(env), SHADOW_LOG_NAME);
}

/** One printable token: no whitespace or control characters, bounded. */
function token(value: string, fallback: string): string {
  let cleaned = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    cleaned += code <= 0x20 || code === 0x7f ? "_" : char;
  }
  return cleaned.slice(0, 200) || fallback;
}

/**
 * The message for one permitted call, on a single line: `would block: <reason>` (or `would hold`)
 * when the judge had decided, and a note that the verdict is still to come when it had not.
 */
export function formatUnenforcedPermit(note: UnenforcedPermit, toolName: string): string {
  const details = [`tool=${token(toolName, "unknown")}`, `mode=${token(note.mode, "unknown")}`];
  if (note.toolCallId !== undefined) details.push(`ref=${token(note.toolCallId.trim(), "none")}`);
  const suffix = ` (${details.join(" ")})`;
  if (note.wouldVerdict === undefined) {
    return `recorded, not judged yet: the verdict will appear in the Atbash dashboard${suffix}`;
  }
  const reason = sanitizeReason(note.reason, "no reason given");
  return `would ${note.wouldVerdict === "HOLD" ? "hold" : "block"}: ${reason}${suffix}`;
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Append one line. Synchronous, so the line is on disk before the hook's process can end. */
export function appendShadowLog(line: string, path: string = shadowLogPath()): void {
  const directory = dirname(path);
  if (lstatIfPresent(directory)?.isSymbolicLink() === true) {
    throw new Error("Refusing a symlinked Atbash configuration directory.");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const existing = lstatIfPresent(path);
  if (existing !== undefined && !existing.isFile()) {
    throw new Error("Refusing a shadow log that is not a regular file.");
  }
  if (existing !== undefined && existing.size > MAX_SHADOW_LOG_BYTES) {
    renameSync(path, `${path}.1`);
  }

  // O_NOFOLLOW is absent on Windows (undefined, so 0); the lstat above is the check there.
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow,
    0o600,
  );
  try {
    writeSync(descriptor, `${line}\n`);
  } finally {
    closeSync(descriptor);
  }
}

export interface ShadowLogOptions {
  path?: string;
  now?: Date;
  /** Where the message is echoed for the host transcript; defaults to stderr. */
  echo?: (message: string) => void;
}

/**
 * Tell the user what enforcement would have done: echo the message to stderr (the host's
 * transcript and debug log) and append it, time-stamped, to the shadow log. The call is already
 * permitted when this runs and nothing here may change that, so every failure is swallowed.
 */
export function recordUnenforcedPermit(
  note: UnenforcedPermit,
  toolName: string,
  options: ShadowLogOptions = {},
): void {
  let message: string;
  try {
    message = formatUnenforcedPermit(note, toolName);
  } catch {
    return;
  }
  try {
    (options.echo ?? ((text: string) => void process.stderr.write(`${text}\n`)))(
      `[atbash] ${message}`,
    );
  } catch {
    // The transcript is optional; the log below is the record.
  }
  try {
    appendShadowLog(`${(options.now ?? new Date()).toISOString()} ${message}`, options.path);
  } catch {
    // A log that cannot be written must not undo or delay a permit.
  }
}
