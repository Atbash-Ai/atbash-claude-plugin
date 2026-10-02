import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * Where the instruction behind a tool call came from, as far as this machine can tell.
 *
 * Prompt injection works by hiding an instruction in content the agent reads (a web page, an
 * email, a tool's output) and getting the agent to act on it. The judge only sees the call, so it
 * cannot tell "the user asked for this" from "a document told the agent to do this". This module
 * computes ONE fact locally from the session transcript and sends only that fact, never any text:
 *
 *   "tool_output": an instruction addressed to the agent ("please ...", "ignore previous ...", an
 *   imperative sentence) appeared in tool output earlier in the session, it shares at least two
 *   distinctive words with this call's argument values, and those words appear nowhere in what the
 *   user typed.
 *
 *   "unknown": anything else, including no transcript, an unreadable one, or any doubt. Unknown
 *   changes nothing about how the call is judged.
 *
 * It never claims "the user asked for this": that label would make the judge MORE permissive, so a
 * wrong guess could be abused. Measured 2026-10-02 (atbash-dashboard JEV benchmark): with this fact,
 * injected attacker calls that JEV allowed on its own fell from 14.5 to 0.5 per run (InjecAgent, 1,054
 * attacks), legitimate decisions were unchanged, and 3 of 2,333 real coding calls (SWE-smith) were
 * flagged.
 */
export type CallOrigin = "tool_output" | "unknown";

/** Only the end of the transcript is read: recent turns are what the next call acts on. */
export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
/** Upper bound on the tool-output text scanned for instructions. */
const MAX_UNTRUSTED_CHARS = 512 * 1024;

export interface TranscriptText {
  /** What the user typed in this session (not hook or system messages). */
  userText: string;
  /** Tool results and attachments: content the agent read but the user did not write. */
  untrustedText: string;
}

const STOP = new Set(
  (
    "this that with from have will your what when where which there their they them then than these those " +
    "into onto about after before please should would could must need make sure file files code line lines test tests using used " +
    "also only just more most some such each other same very like does done here were been being call tool tools user users data " +
    "value values name names path paths true false none null self return function class import print error errors output input " +
    "string number list dict type types args kwargs kindly"
  ).split(" "),
);

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/[#@]?[A-Za-z0-9][A-Za-z0-9_.\-/@]{3,}/g)) {
    const w = m[0].toLowerCase().replace(/[.,;:]+$/, "");
    if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(w);
  }
  return out;
}

/** An instruction addressed to the agent, anywhere in a line ("... 'review': 'Please grant ..."). */
const ADDRESSED =
  /\b(?:please|kindly|you (?:must|should|need to|have to)|ignore (?:all |the )?(?:previous|prior|above)|disregard (?:all |the )?(?:previous|prior|above)|i want you to|your (?:new |next )?task is)\b[^.!?\n'"}\]]{6,240}/gi;
/** An imperative verb opening a sentence or a quoted field ("... 'note': 'Withdraw 5 Bitcoin to ..."). */
const IMPERATIVE_START =
  /(?:^|[.!?]\s+|['":]\s*)((?:withdraw|transfer|send|grant|give|move|delete|remove|leave|share|post|email|upload|forward|pay|buy|sell|deposit|invite|unlock|disable|turn off|install|retrieve|download|export|change|reset|cancel|update|add|schedule|book|follow|tweet|publish|navigate|visit)\b[^.!?\n'"}\]]{6,240})/gi;
/**
 * Source code reads like instructions ("update(...)", "set x = ..."); skip code-looking lines.
 * Braces alone do not make a line code: tool output is often JSON, where injections hide.
 */
const CODE_LINE = /[=;]|\bdef |\bclass |\breturn\b|^\s*(?:#|\/\/|\d+\s)/;

function instructions(untrusted: string): string[] {
  const out: string[] = [];
  for (const line of untrusted.split(/\r?\n|\\n/)) {
    const code = CODE_LINE.test(line);
    if (!code || /\bplease\b/i.test(line)) {
      for (const m of line.matchAll(ADDRESSED)) out.push(m[0]);
    }
    if (!code) {
      for (const m of line.matchAll(IMPERATIVE_START)) out.push(m[1] ?? "");
    }
  }
  return out;
}

function stringValues(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 20) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringValues(v, out, depth + 1);
  else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>))
      stringValues(v, out, depth + 1);
  }
  return out;
}

/** The rule itself, on text already extracted from the transcript. */
export function classifyCallOrigin(
  toolInput: unknown,
  transcript: TranscriptText | null,
): CallOrigin {
  if (transcript === null) return "unknown";
  const user = transcript.userText.toLowerCase();
  const callWords = [...words(stringValues(toolInput).join(" "))].filter((w) => !user.includes(w));
  if (callWords.length < 2) return "unknown";
  const untrusted = transcript.untrustedText.slice(-MAX_UNTRUSTED_CHARS);
  for (const ins of instructions(untrusted)) {
    const iw = words(ins);
    let shared = 0;
    for (const w of callWords) if (iw.has(w)) shared++;
    if (shared >= 2) return "tool_output";
  }
  return "unknown";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part !== null && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
          if (p.content !== undefined) return textOf(p.content);
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

/**
 * Split Claude Code transcript lines into what the user typed and what tools returned.
 * User-typed: `type: "user"` lines whose content is text and that are not `isMeta` (hook and
 * system notes). Untrusted: `tool_result` parts and `attachment` lines. Everything else is ignored.
 * Malformed lines (including a first line cut by the tail read) are skipped.
 */
export function splitTranscript(lines: readonly string[]): TranscriptText {
  const user: string[] = [];
  const untrusted: string[] = [];
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.type === "attachment") {
      untrusted.push(textOf(e.attachment) || JSON.stringify(e.attachment ?? ""));
      continue;
    }
    if (e.type !== "user") continue;
    const message = e.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part === null || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type === "tool_result") untrusted.push(textOf(p.content));
        else if (p.type === "text" && e.isMeta !== true && typeof p.text === "string")
          user.push(p.text);
      }
    } else if (typeof content === "string" && e.isMeta !== true) {
      user.push(content);
    }
  }
  return { userText: user.join("\n"), untrustedText: untrusted.join("\n") };
}

/** Read the last `maxBytes` of the transcript. Never throws: any failure is `null`. */
export function readTranscriptTail(
  path: string,
  maxBytes = MAX_TRANSCRIPT_BYTES,
): TranscriptText | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return splitTranscript(buffer.toString("utf8").split(/\r?\n/));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // nothing to recover
      }
    }
  }
}

/** The fact for one call. Never throws; no transcript, or any failure, is "unknown". */
export function callOriginFor(
  toolInput: unknown,
  transcriptPath: string | null | undefined,
): CallOrigin {
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return "unknown";
  try {
    return classifyCallOrigin(toolInput, readTranscriptTail(transcriptPath));
  } catch {
    return "unknown";
  }
}
