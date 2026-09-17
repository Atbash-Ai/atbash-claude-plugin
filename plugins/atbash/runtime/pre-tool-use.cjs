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
// bundle has none, and the native SDK addon is assumed not to print to fd 1 (its panics go to fd 2);
// such a write can no longer be taken for the decision, but it can still corrupt the shim's deny
// into unparseable stdout, which the host reads as a permit. The bundle's only child processes are
// OpenTelemetry's machine-id lookups through exec with piped stdio, so a child cannot reach fd 1.
// The answer channel is a registered symbol on globalThis, so any code running inside this process
// can find it and call it; that code could equally patch process.exit or write to fd 1, so it is
// no new trust boundary - the channel only ever accepts a deny, never an allow, and a stray permit
// neither disarms the deadline nor outranks a later deny. A channel that some other code installed
// before the shim (a preloaded module, NODE_OPTIONS=--require) is refused with a deny, never
// adopted as the owner of the decision.
const fs = require("node:fs");

const DEFAULT_DEADLINE_MS = 28000;
const MIN_DEADLINE_MS = 1000;
// Under the 30 s SDK request budget and 5 s under the host's 35 s timeout: node start-up and the
// bundle load (~0.2 s warm, more under a cold cache or a scanner) must fit inside the margin.
const MAX_DEADLINE_MS = 30000;
// A queued decision waits for the host to read it until this long past the deadline, then the shim
// gives up with a blocking exit. 30 s + 2 s stays under the host's 35 s timeout.
const DRAIN_GRACE_MS = 2000;
// The longest reason forwarded to the host. A judge verdict is a few hundred characters; the cap
// bounds what a bundle can queue and so bounds the drain the grace period above must cover.
const MAX_REASON_CHARS = 262144;
const CHANNEL = Symbol.for("atbash.hook.answer");

// stdout is the host's decision channel, and only the shim writes to it. The bundled hook hands its
// decision to the shim in-process, through the function installed below under a registered symbol
// (src/hook/protocol.ts HOOK_ANSWER_CHANNEL / deliverDecision): a deny JSON, or "" for a permit.
// Everything the bundle or its libraries write to process.stdout is diverted to stderr (the host
// transcript) - postchain-client's warning() and error() both fire at its default level (LOG_LEVEL
// unset) and a stray line on stdout would corrupt the host's parse. Nothing printed on stdout is
// ever taken for the decision, however well shaped; that residual of a shape check on stdout is
// closed by the channel. The channel accepts exactly one thing: a PreToolUse deny, the object
// serializeDeny emits (tests pin the coupling). It never accepts an allow: the bundle's allow is
// silence, which leaves the host's own permission rules and every other hook in force, and the
// channel must not be a more powerful primitive than that. Anything else on the channel is an
// invalid decision and is denied - including a deny whose reason is not a string.
function isDecision(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const out = JSON.parse(trimmed)?.hookSpecificOutput;
    return (
      typeof out === "object" &&
      out !== null &&
      out.hookEventName === "PreToolUse" &&
      out.permissionDecision === "deny" &&
      typeof out.permissionDecisionReason === "string"
    );
  } catch {
    return false;
  }
}
// decided: a deny is on its way to the host (from the bundle, the deadline, a crash, or the exit
// backstop) - final, later answers are ignored. permitted: the bundle answered "" (allow). A permit
// is not final: it does not disarm the deadline (a permit followed by a lingering handle is still
// denied at the deadline, as before the channel existed), and a later deny overrides it - a stray
// "" from anywhere in-process must never swallow the real decision.
let decided = false;
let permitted = false;
// False only when the channel already holds a function this shim itself installed: a second load
// of the same file in the same process (two paths are two require-cache entries). The first load
// then owns the channel, the exit backstop, the deadline and the bundle, and this load does
// nothing. Anything else already on the channel is foreign, and that is a deny (below).
let firstLoad = true;
// Set once a queued decision has fully left the process (the write callback ran without error).
let delivered = false;

// The bundle's side of the channel.
function answer(output) {
  if (decided) return;
  if (typeof output !== "string") {
    deny("Atbash ERROR: the hook produced an invalid decision.");
    return;
  }
  if (output === "") {
    permitted = true;
    return;
  }
  if (!isDecision(output)) {
    deny("Atbash ERROR: the hook produced an invalid decision.");
    return;
  }
  decided = true;
  // The bundle's deny goes out through the stream: on POSIX a pipe stdout is asynchronous, so a
  // large reason can still drain when the host reads late. The callback ends the process; a write
  // error is a blocking exit, never a permit-shaped 0 with the deny lost; a synchronous throw
  // (a library ended or destroyed the stream) is the same blocking exit; a host that never reads
  // (no callback) is ended by an exit-2 watchdog at the same moment the deadline's decided branch
  // would end the process: DRAIN_GRACE_MS past the deadline, never sooner than the grace itself.
  // The bytes written are the shim's own canonical serialization of the bundle's reason - no
  // sibling key the bundle did not have to prove (an approve-shaped legacy field, say) reaches
  // the host.
  const text = denyJson(JSON.parse(output.trim()).hookSpecificOutput.permissionDecisionReason);
  setTimeout(
    () => exitBlocking("Atbash ERROR: the host did not read the decision in time."),
    drainBudgetMs(),
  ).unref();
  try {
    stdoutWrite(text, (error) => {
      if (error) {
        exitBlocking("Atbash ERROR: the decision could not be delivered to the host.");
        return;
      }
      delivered = true;
      process.exit(0);
    });
  } catch {
    exitBlocking("Atbash ERROR: the decision could not be delivered to the host.");
  }
}

function drainBudgetMs() {
  // Until DRAIN_GRACE_MS past the deadline (which counts from process start), at least the grace.
  const budget = deadlineMs === null ? DEFAULT_DEADLINE_MS : deadlineMs;
  const remaining = budget - Math.ceil(process.uptime() * 1000);
  return Math.max(0, remaining) + DRAIN_GRACE_MS;
}
// Set when the stdout pipe reports an error after the bundle's decision was queued (the host went
// away): the decision was lost, and the decided branch below must not end with a permit-shaped 0.
let stdoutBroken = false;
let stdoutWrite = null;

function exitBlocking(reason) {
  // Nothing can reach stdout: exit 2 is a blocking error for the host, never an empty permit.
  // `delivered` stays false: should process.exit itself have been patched away in-process, the
  // exit backstop still turns this into exit code 2 rather than a permit-shaped 0.
  decided = true;
  try {
    fs.writeSync(2, reason + "\n");
  } catch {
    // nothing left to report to
  }
  process.exit(2);
}

function writeDecisionSync(output) {
  // Every byte, or an error: a pipe write can be partial, and on POSIX the pipe behind fd 1 is
  // non-blocking once process.stdout exists, so a momentarily full pipe answers EAGAIN - retried
  // briefly rather than treated as a dead host.
  const buffer = Buffer.from(output, "utf8");
  let offset = 0;
  let attempt = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(1, buffer, offset, buffer.length - offset);
      attempt = 0;
    } catch (error) {
      if (!(error && error.code === "EAGAIN") || attempt >= 40) throw error;
      attempt += 1;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function deny(reason) {
  if (decided) {
    // A decision is already on its way but the process is still alive (a lingering handle): that
    // decision stands. On POSIX a pipe stdout is asynchronous, so the bytes may still be queued; an
    // empty write's callback fires once everything before it has drained, and only then does the
    // process end. If the pipe broke or never drains, exit 2 (a blocking error) rather than a
    // permit-shaped 0 or a wait for the host timeout.
    if (stdoutBroken) exitBlocking(reason);
    setTimeout(
      () => exitBlocking("Atbash ERROR: the host did not read the decision in time."),
      DRAIN_GRACE_MS,
    ).unref();
    stdoutWrite("", (error) => {
      if (error) {
        exitBlocking("Atbash ERROR: the decision could not be delivered to the host.");
        return;
      }
      delivered = true;
      process.exit(0);
    });
    return;
  }
  decided = true;
  try {
    writeDecisionSync(denyJson(reason));
    delivered = true;
    process.exit(0);
  } catch {
    exitBlocking(reason);
  }
}

function denyJson(reason) {
  const text =
    reason.length > MAX_REASON_CHARS
      ? reason.slice(0, MAX_REASON_CHARS) + " [reason truncated by the hook]"
      : reason;
  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: text,
      },
    }) + "\n"
  );
}

// The exit-time backstop, registered before anything below can go wrong. Every fail-closed
// trigger needs an event: a throw, a rejection, a load failure, or the deadline timer - and the
// timer is unref'd so a hook that answered can end. A bundle that simply RETURNS without
// answering (an early return, a swallowed error, a truncated or swapped bundle whose top-level
// call is gone, a library calling process.exit(0)) fires none of them: the loop drains, node
// exits 0 with an empty stdout, and the host reads a permit. So the last word is here: at exit,
// no decision and no permit is a deny written synchronously with exit 0; a decision whose stdout
// write errored (the host went away) or never drained (in-process code ended the process first)
// is a blocking exit code rather than a permit-shaped 0; a permit stays silence. On a second load
// of the shim (firstLoad false, decided below) the first load's listener owns the exit and this
// one is silent - two listeners would write two decisions, which the host cannot parse. What this
// cannot cover: process.abort or a signal from the native addon ends the process without running
// exit listeners (a non-0/2 exit, which the host treats as non-blocking).
process.on("exit", () => {
  if (!firstLoad) return;
  if (decided) {
    // A decision that was queued but never drained (the host went away, or in-process code called
    // process.exit while the deny was still in the pipe) must not end as a permit-shaped 0 with
    // partial or empty stdout. A blocking exit code is the honest answer.
    if (stdoutBroken || !delivered) process.exitCode = 2;
    return;
  }
  if (permitted) return;
  decided = true;
  try {
    writeDecisionSync(denyJson("Atbash ERROR: the hook ended without a decision."));
    delivered = true;
    process.exitCode = 0;
  } catch {
    try {
      fs.writeSync(2, "Atbash ERROR: the hook ended without a decision.\n");
    } catch {
      // nothing left to report to
    }
    process.exitCode = 2;
  }
});

// The channel is installed once, branded as this shim's own. A second load of the shim in the same
// process (two paths to the same file are two require-cache entries) finds the branded function
// and steps aside. Anything else already on the channel - a function some preloaded module put
// there (NODE_OPTIONS=--require, a patched host), or a non-function value - is foreign: the
// bundle's deny would go to that code, not to the host, so the tool call is denied here and now.
// The brand is not a secret (in-process code can forge it; see the boundary note at the top): it
// distinguishes the shim's own second load from everything else, so that no pre-installed
// function turns the shim into a silent permit.
try {
  const existing = globalThis[CHANNEL];
  if (existing !== undefined) {
    if (typeof existing === "function" && existing.atbashShim === true) {
      firstLoad = false;
    } else {
      deny("Atbash ERROR: the hook's decision channel was already taken.");
    }
  } else {
    Object.defineProperty(answer, "atbashShim", { value: true });
    Object.defineProperty(globalThis, CHANNEL, {
      value: answer,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }
} catch {
  exitBlocking("Atbash ERROR: the hook could not install its decision channel.");
}

// Installing the stdout guard touches process.stdout, which can itself throw when fd 1 is closed at
// spawn (EBADF); that must end as a blocking error, not as node's default exit 1 with no output.
// Only the first load installs it: a second load would wrap the diverter again and add a second
// error listener - harmless, but a second load does nothing at all.
if (firstLoad) {
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
  } catch {
    exitBlocking("Atbash ERROR: the hook could not attach to the host's output.");
  }
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
if (!firstLoad) {
  // A second load: the first one owns the process.
} else if (deadlineMs === null) {
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
