"use strict";
// The shipped entry point. Plain CommonJS, no dependencies, never bundled: it must keep working when
// the bundled hook next to it cannot load. Claude Code lets a tool call proceed when a hook times
// out or exits with a code other than 0 or 2, so the two failures that would silently remove the
// gate are handled here, before the real hook is even loaded:
//   1. a hard deadline under the host's hook timeout (hooks.json: 35 s) - the SDK's per-request
//      budget is up to 30 s and one judgment is two to five requests, so without this a slow but
//      alive judge outlives the host timeout and the host proceeds;
//   2. any failure of the bundled hook itself - a load error, an uncaught exception, an unhandled
//      rejection - becomes a deny with exit 0 instead of exit 1 with nothing on stdout.
// The deny text is fixed here; nothing from the failure is echoed to the host. The deny is written
// synchronously, so it cannot be lost to an undrained pipe; if stdout cannot be written at all the
// shim exits 2 (a blocking error for the host) rather than 0 with an empty, permit-shaped stdout.
// The bundle's own decision reaches the shim over a private in-process channel (below), never over
// stdout. What this cannot close: a synchronous hang inside the bundle or the native addon keeps
// the event loop from ever running the deadline timer; only the host timeout ends that. A write
// straight to file descriptor 1 (not through process.stdout) is not intercepted either: the JS
// bundle has none, and the native SDK addon is assumed not to print to fd 1 (its panics go to fd 2).
const fs = require("node:fs");

const DEFAULT_DEADLINE_MS = 28000;
const MIN_DEADLINE_MS = 1000;
// Under the 30 s SDK request budget and 5 s under the host's 35 s timeout: node start-up and the
// bundle load (~0.2 s warm, more under a cold cache or a scanner) must fit inside the margin.
const MAX_DEADLINE_MS = 30000;

// stdout is the host's decision channel, and only the shim writes to it. The bundled hook hands its
// decision to the shim in-process, through the function installed below under a registered symbol
// (src/hook/protocol.ts HOOK_ANSWER_CHANNEL / deliverDecision): a deny JSON, or "" for a permit.
// Everything the bundle or its libraries write to process.stdout is diverted to stderr (the host
// transcript) - postchain-client's warning() and error() both fire at its default level (LOG_LEVEL
// unset) and a stray line on stdout would corrupt the host's parse. Nothing printed on stdout is
// ever taken for the decision, however well shaped; that residual of a shape check on stdout is
// closed by the channel. The channel's payload is still checked (one JSON object with a
// hookSpecificOutput.permissionDecision string, which is what serializeDeny emits - tests pin the
// coupling): a malformed answer is a deny, never an exit 0 with an unparseable or empty stdout.
function isDecision(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed?.hookSpecificOutput?.permissionDecision === "string";
  } catch {
    return false;
  }
}
let answered = false;

// The bundle's side of the channel. The first call decides; later calls are ignored (the decision
// already stands, and a second JSON on stdout would be unparseable, which the host reads as a
// non-blocking message). A permit ("") is recorded so a lingering handle does not turn an allowed
// call into a deadline deny; nothing is written for it.
function answer(output) {
  if (answered) return;
  if (typeof output !== "string") {
    deny("Atbash ERROR: the hook produced an invalid decision.");
    return;
  }
  if (output === "") {
    answered = true;
    return;
  }
  if (!isDecision(output)) {
    deny("Atbash ERROR: the hook produced an invalid decision.");
    return;
  }
  answered = true;
  stdoutWrite(output.endsWith("\n") ? output : output + "\n");
}
// Set when the stdout pipe reports an error after the bundle's decision was queued (the host went
// away): the decision was lost, and the answered branch below must not end with a permit-shaped 0.
let stdoutBroken = false;
let stdoutWrite = null;

function exitBlocking(reason) {
  // Nothing can reach stdout: exit 2 is a blocking error for the host, never an empty permit.
  try {
    fs.writeSync(2, reason + "\n");
  } catch {
    // nothing left to report to
  }
  process.exit(2);
}

function writeDecisionSync(output) {
  // On POSIX the pipe behind fd 1 is non-blocking once process.stdout exists; a momentarily full
  // pipe answers EAGAIN, which is retried briefly rather than treated as a dead host.
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.writeSync(1, output);
      return;
    } catch (error) {
      if (!(error && error.code === "EAGAIN") || attempt >= 40) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function deny(reason) {
  if (answered) {
    // The bundle already wrote its decision but is still alive (a lingering handle): its decision
    // stands. On POSIX a pipe stdout is asynchronous, so the bytes may still be queued; an empty
    // write's callback fires once everything before it has drained, and only then does the process
    // end. If the pipe broke or never drains, exit 2 (a blocking error) rather than a permit-shaped
    // 0 or a wait for the host timeout.
    if (stdoutBroken) exitBlocking(reason);
    setTimeout(() => process.exit(2), 2000).unref();
    stdoutWrite("", (error) => process.exit(error ? 2 : 0));
    return;
  }
  answered = true;
  const output =
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n";
  try {
    writeDecisionSync(output);
    process.exit(0);
  } catch {
    exitBlocking(reason);
  }
}

// Installing the stdout guard touches process.stdout, which can itself throw when fd 1 is closed at
// spawn (EBADF); that must end as a blocking error, not as node's default exit 1 with no output.
try {
  stdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.on("error", () => {
    stdoutBroken = true;
  });
  // A host that closed stderr must not turn every diverted log line into a crash deny.
  process.stderr.on("error", () => {});
  // Every write the bundle makes to process.stdout is a log line: to stderr, whatever it looks like.
  process.stdout.write = function (chunk, encoding, callback) {
    return process.stderr.write(chunk, encoding, callback);
  };
  Object.defineProperty(globalThis, Symbol.for("atbash.hook.answer"), {
    value: answer,
    writable: false,
    configurable: false,
    enumerable: false,
  });
} catch {
  exitBlocking("Atbash ERROR: the hook could not attach to the host's output.");
}

function resolveDeadlineMs(raw) {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DEADLINE_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_DEADLINE_MS || parsed > MAX_DEADLINE_MS) {
    return null;
  }
  return parsed;
}

const deadlineMs = resolveDeadlineMs(process.env.ATBASH_HOOK_DEADLINE_MS);
if (deadlineMs === null) {
  deny(
    "Atbash ERROR: ATBASH_HOOK_DEADLINE_MS must be an integer between " +
      MIN_DEADLINE_MS +
      " and " +
      MAX_DEADLINE_MS +
      ".",
  );
} else {
  // The deadline counts from process start, not from here: node's own start-up is inside the
  // host's clock too. unref: a hook that answers normally lets the event loop drain and exits on
  // its own; only a hook still waiting on the judge keeps the loop alive long enough for this.
  const elapsedMs = Math.ceil(process.uptime() * 1000);
  setTimeout(
    () => {
      deny("Atbash ERROR: the safety check did not finish before the host's hook timeout.");
    },
    Math.max(0, deadlineMs - elapsedMs),
  ).unref();

  process.on("uncaughtException", () => {
    deny("Atbash ERROR: the hook crashed before a decision was returned.");
  });
  process.on("unhandledRejection", () => {
    deny("Atbash ERROR: the hook crashed before a decision was returned.");
  });

  try {
    require("./pre-tool-use-main.cjs");
  } catch {
    deny("Atbash ERROR: the hook runtime could not load.");
  }
}
