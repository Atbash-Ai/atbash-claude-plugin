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
/** First pass over the call: this much of every value, shortest values first. */
const FIRST_PASS_VALUE_CHARS = 4 * 1024;
/** Transcript content nested deeper than this is not text anyone wrote; it is skipped. */
const MAX_CONTENT_DEPTH = 32;
/** A token longer than this is not a word anyone would repeat; it is skipped. */
const MAX_WORD_LENGTH = 64;
/**
 * The whole check gives up after this long. A hard stop for pathological input only, far below
 * Claude Code's 35 s hook timeout; the worst case an attacker can build within the 512 KiB window
 * (a flood of instruction-like or very short lines) measured 30-240 ms alone and up to 334 ms with
 * the whole test suite running in parallel, so the budget cannot be used to suppress the fact
 * (security re-reviews 2026-10-03). On a host several times slower the check gives up and adds
 * nothing: the call is judged as it was before this check existed, never allowed more easily.
 */
export const TIME_BUDGET_MS = 1000;

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

const isAlnum = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
/** Word characters: a-z 0-9 _ . - / @ # (the text is lower-cased first). */
const isWordChar = (c: number): boolean =>
  isAlnum(c) || c === 95 || c === 46 || c === 45 || c === 47 || c === 64 || c === 35;
/** Trailing punctuation trimmed from a word: . , ; : */
const isTrailing = (c: number): boolean => c === 46 || c === 44 || c === 59 || c === 58;

/**
 * Calls `visit` with each word of lower-cased `text`, in one pass over its characters (no regex
 * match objects: a flood of instruction-like text must stay far inside the time budget). A word is
 * a run of word characters that starts with a letter or digit (or one "#" / "@" before one), with
 * trailing ".,;:" trimmed and at most MAX_WORD_LENGTH characters: a longer run keeps its prefix.
 * `visit` returns true to stop early.
 */
function scanWords(text: string, tick: () => void, visit: (word: string) => boolean | void): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (!isWordChar(text.charCodeAt(i))) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && isWordChar(text.charCodeAt(j))) j++;
    tick();
    let start = i;
    // Leading punctuation is not part of a word; one "#" or "@" right before a letter or digit is.
    while (start < j && !isAlnum(text.charCodeAt(start))) {
      const c = text.charCodeAt(start);
      if ((c === 35 || c === 64) && start + 1 < j && isAlnum(text.charCodeAt(start + 1))) break;
      start++;
    }
    let end = Math.min(j, start + MAX_WORD_LENGTH);
    while (end > start && isTrailing(text.charCodeAt(end - 1))) end--;
    if (end - start >= 4 && visit(text.slice(start, end)) === true) return;
    i = j;
  }
}

/** Distinctive words of `text`: stop words, pure numbers and short words are left out. */
function words(text: string, tick: () => void): Set<string> {
  const out = new Set<string>();
  scanWords(text.toLowerCase(), tick, (w) => {
    if (!STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
  });
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
/** The shortest text either pattern can match: a three-letter verb plus a six-character tail. */
const MIN_INSTRUCTION_CHARS = 9;
/** A code-looking line is still read for an addressed instruction when it says "please". */
const PLEASE = /\bplease\b/i;

/**
 * Instructions in tool output, one line at a time, so each is compared as soon as it is found.
 * The instruction spans on a line are merged (the two patterns often overlap) and yielded once,
 * lower-cased, so no text is scanned twice (security re-review 2026-10-03: a flood of
 * instruction-like lines must not push the check past its time budget).
 */
function* instructions(untrusted: string, tick: () => void): Generator<string> {
  // Lines end at a newline or a literal backslash-n (tool output is often JSON-escaped). They are
  // found with indexOf, not a regex split, and a line too short to hold an instruction is skipped
  // before any regex runs: the cost must not grow with the number of lines (security re-review
  // 2026-10-03: 512K empty lines ran out the budget).
  const n = untrusted.length;
  let pos = 0;
  let nextNewline = untrusted.indexOf("\n");
  let nextEscaped = untrusted.indexOf("\\n");
  while (pos <= n) {
    if (nextNewline !== -1 && nextNewline < pos) nextNewline = untrusted.indexOf("\n", pos);
    if (nextEscaped !== -1 && nextEscaped < pos) nextEscaped = untrusted.indexOf("\\n", pos);
    let cut = n;
    let step = 0;
    if (nextNewline !== -1 && (nextEscaped === -1 || nextNewline < nextEscaped)) {
      cut = nextNewline;
      step = 1;
    } else if (nextEscaped !== -1) {
      cut = nextEscaped;
      step = 2;
    }
    const lineStart = pos;
    let lineEnd = cut;
    if (step === 1 && lineEnd > lineStart && untrusted.charCodeAt(lineEnd - 1) === 13) lineEnd--;
    pos = step === 0 ? n + 1 : cut + step;
    tick();
    if (lineEnd - lineStart < MIN_INSTRUCTION_CHARS) continue;
    const line = untrusted.slice(lineStart, lineEnd);
    const code = CODE_LINE.test(line);
    const spans: Array<[number, number]> = [];
    if (!code || PLEASE.test(line)) {
      ADDRESSED.lastIndex = 0;
      for (let m = ADDRESSED.exec(line); m !== null; m = ADDRESSED.exec(line)) {
        spans.push([m.index, m.index + m[0].length]);
      }
    }
    if (!code) {
      IMPERATIVE_START.lastIndex = 0;
      for (let m = IMPERATIVE_START.exec(line); m !== null; m = IMPERATIVE_START.exec(line)) {
        const text = m[1] ?? "";
        const start = m.index + m[0].length - text.length;
        spans.push([start, start + text.length]);
      }
    }
    if (spans.length === 0) continue;
    spans.sort((a, b) => a[0] - b[0]);
    let [start, end] = spans[0] as [number, number];
    for (const [s, e] of spans.slice(1)) {
      if (s <= end) end = Math.max(end, e);
      else {
        yield line.slice(start, end).toLowerCase();
        [start, end] = [s, e];
      }
    }
    yield line.slice(start, end).toLowerCase();
  }
}

/** True when `text` (lower-case) holds at least two distinct words of `callWords`. One pass. */
function sharesTwoWords(text: string, callWords: ReadonlySet<string>, tick: () => void): boolean {
  let first: string | undefined;
  let found = false;
  scanWords(text, tick, (w) => {
    if (!callWords.has(w)) return false;
    if (first === undefined) first = w;
    else if (w !== first) found = true;
    return found;
  });
  return found;
}

/**
 * The call's string values within MAX_CALL_CHARS. First pass: up to 4 KiB of every value, shortest
 * values first, so short values that name a target (a recipient, a URL) always count and a long
 * body cannot crowd them out. Second pass: the rest of the long values, so a target written past
 * 4 KiB in one value still counts (security re-review 2026-10-03). Every leaf costs budget.
 */
function stringValues(toolInput: unknown, tick: () => void): string[] {
  const values: string[] = [];
  let leaves = 0;
  const walk = (value: unknown, depth: number): void => {
    tick();
    if (depth > 20 || leaves >= MAX_CALL_CHARS) return;
    leaves++;
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) for (const v of value) walk(v, depth + 1);
    else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v, depth + 1);
    }
  };
  walk(toolInput, 0);
  values.sort((a, b) => a.length - b.length);
  let budget = MAX_CALL_CHARS - leaves;
  const out: string[] = [];
  for (const v of values) {
    if (budget <= 0) break;
    const part = v.slice(0, Math.min(FIRST_PASS_VALUE_CHARS, budget));
    budget -= part.length;
    out.push(part);
  }
  for (const v of values) {
    if (budget <= 0) break;
    if (v.length <= FIRST_PASS_VALUE_CHARS) continue;
    // Starts one word length before the first-pass cut, so a word that crosses the cut is read
    // whole here (security re-review 2026-10-03).
    const from = FIRST_PASS_VALUE_CHARS - MAX_WORD_LENGTH;
    const rest = v.slice(from, from + budget);
    budget -= rest.length;
    out.push(rest);
  }
  return out;
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
    // No word cap: the 64 KiB character budget already bounds the set (about 13K words), and a
    // cap would let a flood of short values crowd out the target (security re-review 2026-10-03).
    const callWords = new Set<string>();
    for (const w of words(stringValues(toolInput, tick).join(" "), tick)) {
      if (!userWords.has(w)) callWords.add(w);
    }
    if (callWords.size < 2) return "unknown";
    const untrusted = transcript.untrustedText.slice(-MAX_UNTRUSTED_CHARS);
    // Cost is linear in the instruction text: each word is looked up in the call's set once.
    for (const ins of instructions(untrusted, tick)) {
      if (sharesTwoWords(ins, callWords, tick)) return "tool_output";
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
