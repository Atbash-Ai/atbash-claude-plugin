import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

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
 *   "unknown": anything else, including no transcript, an unreadable one, input too large to check
 *   within the time budget, or any doubt. Unknown changes nothing about how the call is judged.
 *
 * It never claims "the user asked for this": that label would make the judge MORE permissive, so a
 * wrong guess could be abused. Measured 2026-10-02 (atbash-dashboard JEV benchmark), with this
 * module's compiled code: injected attacker calls that JEV allowed on its own fell from 14.5 to 0.5
 * per run (InjecAgent, 1,054 attacks, non-adaptive), legitimate decisions were unchanged, and 12 of
 * 2,333 real coding calls (SWE-smith) were flagged.
 *
 * This step runs before the judge call, and Claude Code lets a tool run if the hook dies on its
 * timeout, so every step here is linear in its input, every input is capped, and the whole check
 * gives up ("unknown") after TIME_BUDGET_MS (security review 2026-10-02).
 */
export type CallOrigin = "tool_output" | "unknown";

/** Only the end of the transcript is read: recent turns are what the next call acts on. */
export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
/** Upper bound on the tool-output text scanned for instructions. */
const MAX_UNTRUSTED_CHARS = 512 * 1024;
/** Upper bound on the user text and on the call's argument values (in total, and per value). */
const MAX_USER_CHARS = 256 * 1024;
const MAX_CALL_CHARS = 64 * 1024;
const MAX_VALUE_CHARS = 4 * 1024;
/** Upper bound on the call words compared. Instructions are not counted: each is compared as
 * soon as it is found, so decoys cannot crowd out the real one (security re-review 2026-10-03). */
const MAX_CALL_WORDS = 2000;
/** Transcript content nested deeper than this is not text anyone wrote; it is skipped. */
const MAX_CONTENT_DEPTH = 32;
/** A token longer than this is not a word anyone would repeat; it is skipped. */
const MAX_WORD_LENGTH = 64;
/** The whole check gives up after this long. */
export const TIME_BUDGET_MS = 200;

const STOP = new Set(
  (
    "this that with from have will your what when where which there their they them then than these those " +
    "into onto about after before please should would could must need make sure file files code line lines test tests using used " +
    "also only just more most some such each other same very like does done here were been being call tool tools user users data " +
    "value values name names path paths true false none null self return function class import print error errors output input " +
    "string number list dict type types args kwargs kindly"
  ).split(" "),
);

class OverBudget extends Error {}

function makeDeadline(): () => void {
  const end = performance.now() + TIME_BUDGET_MS;
  let n = 0;
  return () => {
    // Checking the clock every call would cost more than the work; every 256 steps is enough.
    if ((++n & 0xff) === 0 && performance.now() > end) throw new OverBudget();
  };
}

/** Distinctive words, linear in the input: bounded token length, punctuation trimmed by a loop. */
function words(text: string, tick: () => void, limit = Number.POSITIVE_INFINITY): Set<string> {
  const out = new Set<string>();
  // Tokens are bounded ({3,63} after the first character), so a run of 250,000 dots is many short
  // tokens, never one huge one.
  for (const m of text.matchAll(/[#@]?[A-Za-z0-9][A-Za-z0-9_.\-/@]{3,63}/g)) {
    tick();
    let w = m[0].toLowerCase();
    let end = w.length;
    while (end > 0 && ".,;:".includes(w[end - 1] ?? "")) end--;
    w = w.slice(0, end);
    if (w.length < 4 || w.length > MAX_WORD_LENGTH || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(w);
    if (out.size >= limit) break;
  }
  return out;
}

/**
 * The text of an instruction: up to 240 characters, ending at a sentence end or a closing quote.
 * A "." "!" or "?" ends it only when no word character follows, so an address or URL inside it
 * (payroll-backup@exfil-example.net, https://a.b/c) stays whole. One character per step: linear.
 */
const INSTRUCTION_TAIL = String.raw`(?:[^.!?\n'"}\]]|[.!?](?=\w)){6,240}`;
/** An instruction addressed to the agent, anywhere in a line ("... 'review': 'Please grant ..."). */
const ADDRESSED = new RegExp(
  String.raw`\b(?:please|kindly|you (?:must|should|need to|have to)|ignore (?:all |the )?(?:previous|prior|above)|disregard (?:all |the )?(?:previous|prior|above)|i want you to|your (?:new |next )?task is)\b` +
    INSTRUCTION_TAIL,
  "gi",
);
/** An imperative verb opening a sentence or a quoted field ("... 'note': 'Withdraw 5 Bitcoin to ..."). */
const IMPERATIVE_START = new RegExp(
  String.raw`(?:^|[.!?]\s+|['":]\s*)((?:withdraw|transfer|send|grant|give|move|delete|remove|leave|share|post|email|upload|forward|pay|buy|sell|deposit|invite|unlock|disable|turn off|install|retrieve|download|export|change|reset|cancel|update|add|schedule|book|follow|tweet|publish|navigate|visit)\b` +
    INSTRUCTION_TAIL +
    ")",
  "gi",
);
/**
 * Source code reads like instructions ("update(...)", "set x = ..."); skip code-looking lines.
 * Braces alone do not make a line code: tool output is often JSON, where injections hide.
 */
const CODE_LINE = /[=;]|\bdef |\bclass |\breturn\b|^\s*(?:#|\/\/|\d+\s)/;

/** Instructions in tool output, yielded one at a time so each is compared as soon as it is found. */
function* instructions(untrusted: string, tick: () => void): Generator<string> {
  for (const line of untrusted.split(/\r?\n|\\n/)) {
    tick();
    const code = CODE_LINE.test(line);
    if (!code || /\bplease\b/i.test(line)) {
      for (const m of line.matchAll(ADDRESSED)) yield m[0];
    }
    if (!code) {
      for (const m of line.matchAll(IMPERATIVE_START)) yield m[1] ?? "";
    }
  }
}

/**
 * The call's string values, each capped, shortest first: the short values (a recipient, a URL, an
 * account) are the ones that name a target, so a long body listed first cannot use up the budget
 * before them (security re-review 2026-10-03). Every leaf counts against the budget.
 */
function stringValues(toolInput: unknown, tick: () => void): string[] {
  const out: string[] = [];
  const budget = { chars: MAX_CALL_CHARS };
  const walk = (value: unknown, depth: number): void => {
    tick();
    if (depth > 20 || budget.chars <= 0) return;
    budget.chars -= 1;
    if (typeof value === "string") {
      const part = value.slice(0, Math.min(MAX_VALUE_CHARS, budget.chars));
      budget.chars -= part.length;
      out.push(part);
    } else if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
    } else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v, depth + 1);
    }
  };
  walk(toolInput, 0);
  return out.sort((a, b) => a.length - b.length);
}

/** The rule itself, on text already extracted from the transcript. Never throws. */
export function classifyCallOrigin(
  toolInput: unknown,
  transcript: TranscriptText | null,
): CallOrigin {
  if (transcript === null) return "unknown";
  const tick = makeDeadline();
  try {
    const userWords = words(transcript.userText.slice(-MAX_USER_CHARS), tick);
    const callWords = new Set<string>();
    for (const w of words(stringValues(toolInput, tick).join(" "), tick, MAX_CALL_WORDS * 4)) {
      if (!userWords.has(w)) callWords.add(w);
      if (callWords.size >= MAX_CALL_WORDS) break;
    }
    if (callWords.size < 2) return "unknown";
    const untrusted = transcript.untrustedText.slice(-MAX_UNTRUSTED_CHARS);
    // Cost is the total words across instructions (each at most ~240 characters), not
    // instructions x call words: each instruction's own words are looked up in the call's set.
    for (const ins of instructions(untrusted, tick)) {
      let shared = 0;
      for (const w of words(ins, tick)) {
        if (callWords.has(w) && ++shared >= 2) return "tool_output";
      }
    }
    return "unknown";
  } catch {
    // Over budget, or anything unexpected: no claim either way.
    return "unknown";
  }
}

function textOf(content: unknown, depth = 0): string {
  if (typeof content === "string") return content;
  if (depth >= MAX_CONTENT_DEPTH) return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part !== null && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
          if (p.content !== undefined) return textOf(p.content, depth + 1);
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
    // One malformed or pathological line is skipped; it never discards the rest of the transcript.
    try {
      const entry: unknown = JSON.parse(line);
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
    } catch {
      continue;
    }
  }
  return { userText: user.join("\n"), untrustedText: untrusted.join("\n") };
}

export interface TranscriptText {
  /** What the user typed in this session (not hook or system messages). */
  userText: string;
  /** Tool results and attachments: content the agent read but the user did not write. */
  untrustedText: string;
}

/** Network paths (\\host\share, //host/share) are never opened: no outbound connection from the hook. */
function isNetworkPath(path: string): boolean {
  return /^(?:\\\\|\/\/)/.test(path);
}

/**
 * Read the last `maxBytes` of the transcript. Never throws: any failure is `null`.
 * Only an absolute, local, regular file is read; a pipe, FIFO, device or network path is refused
 * before it is opened, because opening one can block the hook (security review 2026-10-02).
 */
export function readTranscriptTail(
  path: string,
  maxBytes = MAX_TRANSCRIPT_BYTES,
): TranscriptText | null {
  if (!isAbsolute(path) || isNetworkPath(path)) return null;
  let fd: number | undefined;
  try {
    if (!statSync(path).isFile()) return null;
    // O_NONBLOCK where it exists (POSIX): a file swapped for a FIFO after the check cannot block.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, stat.size - length);
    return splitTranscript(buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/));
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
