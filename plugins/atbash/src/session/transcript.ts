import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Bytes read from the end of the transcript. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/**
 * Where Claude Code keeps session transcripts:
 * `<config dir>/projects/<project>/<session>.jsonl`, where the config dir is
 * `CLAUDE_CONFIG_DIR` when set and `~/.claude` otherwise.
 */
export function transcriptRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return resolve(
    configDir !== undefined && configDir !== "" ? configDir : join(homedir(), ".claude"),
    "projects",
  );
}

function isInside(root: string, candidate: string): boolean {
  const a = process.platform === "win32" ? root.toLowerCase() : root;
  const b = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const rel = relative(a, b);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Read at most `maxBytes` from the end of a transcript, or undefined when the
 * path is not a regular `.jsonl` file under `root`. Symlinks are refused, both
 * at the file itself and through a directory that resolves outside the root.
 * The first, possibly partial, line of a tail read is dropped. Never throws.
 */
export async function readTranscriptTail(
  transcriptPath: unknown,
  root: string,
  maxBytes = TRANSCRIPT_TAIL_BYTES,
): Promise<string | undefined> {
  try {
    if (
      typeof transcriptPath !== "string" ||
      transcriptPath === "" ||
      !isAbsolute(transcriptPath)
    ) {
      return undefined;
    }
    if (!transcriptPath.toLowerCase().endsWith(".jsonl") || transcriptPath.includes("\0")) {
      return undefined;
    }

    const linkStat = await lstat(transcriptPath, { bigint: true });
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
      return undefined;
    }

    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(transcriptPath)]);
    if (!isInside(realRoot, realFile)) {
      return undefined;
    }

    // O_NOFOLLOW where the platform has it; everywhere, the opened handle must
    // be the same file that was checked above.
    const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    const handle = await open(realFile, constants.O_RDONLY | noFollow);
    try {
      const openStat = await handle.stat({ bigint: true });
      if (!openStat.isFile() || openStat.ino !== linkStat.ino || openStat.dev !== linkStat.dev) {
        return undefined;
      }
      const size = Number(openStat.size);
      const start = Math.max(0, size - maxBytes);
      const length = size - start;
      if (length <= 0) {
        return "";
      }
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      if (start === 0) {
        return text;
      }
      const firstNewline = text.indexOf("\n");
      return firstNewline < 0 ? "" : text.slice(firstNewline + 1);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export interface TranscriptStep {
  id: string;
  name: string;
  input: string;
  result?: string;
  isError?: boolean;
}

export interface TranscriptExtract {
  userRequest?: string;
  steps: TranscriptStep[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Host-generated "user" entries that are not something the person asked for.
const NON_REQUEST_PREFIXES = [
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<task-notification>",
];

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join(" ");
}

function userRequestOf(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): string | undefined {
  if (entry.isMeta === true) {
    return undefined;
  }
  if (isRecord(entry.origin) && entry.origin.kind !== "human") {
    return undefined;
  }
  const content = message.content;
  if (
    Array.isArray(content) &&
    content.some((block) => isRecord(block) && block.type === "tool_result")
  ) {
    return undefined;
  }
  const text = textOf(content).trim();
  if (text === "" || NON_REQUEST_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    return undefined;
  }
  return text;
}

function stringifyInput(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return "";
  }
}

/**
 * Pull the latest human request and the assistant tool calls (with their
 * results) out of JSONL transcript text. Malformed lines, unknown entry types
 * and subagent (sidechain) entries are skipped. Never throws.
 */
export function extractTranscript(jsonl: string): TranscriptExtract {
  let userRequest: string | undefined;
  const steps: TranscriptStep[] = [];
  const byId = new Map<string, TranscriptStep>();

  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.isSidechain === true || !isRecord(entry.message)) {
      continue;
    }
    const message = entry.message;

    if (entry.type === "user") {
      const request = userRequestOf(entry, message);
      if (request !== undefined) {
        userRequest = request;
      }
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (
            !isRecord(block) ||
            block.type !== "tool_result" ||
            typeof block.tool_use_id !== "string"
          ) {
            continue;
          }
          const step = byId.get(block.tool_use_id);
          if (step !== undefined) {
            step.result = textOf(block.content);
            if (block.is_error === true) {
              step.isError = true;
            }
          }
        }
      }
    } else if (entry.type === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          !isRecord(block) ||
          block.type !== "tool_use" ||
          typeof block.id !== "string" ||
          typeof block.name !== "string"
        ) {
          continue;
        }
        const step: TranscriptStep = {
          id: block.id,
          name: block.name,
          input: stringifyInput(block.input),
        };
        steps.push(step);
        byId.set(step.id, step);
      }
    }
  }

  return { ...(userRequest === undefined ? {} : { userRequest }), steps };
}
