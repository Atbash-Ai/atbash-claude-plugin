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
// before the shim (a preloaded module, NODE_OPTIONS=--require) is refused with a deny on stdout
// and exit 0 (already on stdout when the loop drains, should process.exit have been patched away
// in-process), whatever it looks like: the shim owns the channel or it decides nothing else. Exit
// 2 is the answer only when stdout cannot be written at all - blocking for Claude Code, a permit
// on Codex 0.154.0 (measured: that host blocks on a deny with exit 0 and on nothing else), which
// no hook can help. In-process code that makes process.exit THROW ends the hook at node's exit 1
// (non-blocking for the host) whatever the shim does - it is the same in-process control as
// patching fs, and out of scope. A pipe write to a host that never reads blocks on Windows for any
// deny larger than the pipe's buffer, and nothing in-process can interrupt it (a blocked event
// loop runs no watchdog; a blocked pool thread is joined by process.exit) - so the deny is bounded
// in serialized BYTES (below) under the smallest buffer a host hands a hook, and the write always
// completes. The write goes to file descriptor 1 off the event loop, and a watchdog bounds the
// wait for a host that reads late, as defence in depth behind that bound.
const fs = require("node:fs");

const DEFAULT_DEADLINE_MS = 28000;
const MIN_DEADLINE_MS = 1000;
// Under the 30 s SDK request budget and 5 s under the host's 35 s timeout: node start-up and the
// bundle load (~0.2 s warm, more under a cold cache or a scanner) must fit inside the margin.
const MAX_DEADLINE_MS = 30000;
// A queued decision waits for the host to read it until this long past the deadline, then the shim
// gives up with a blocking exit. 30 s + 2 s stays under the host's 35 s timeout.
const DRAIN_GRACE_MS = 2000;
// The largest deny written to the host, in serialized bytes: under the smallest pipe buffer a
// host is known to hand a hook (4 KiB for a bare CreatePipe; libuv pipes have 64 KiB), so the
// write always completes into the pipe whether or not the host has read yet, and no host can hold
// it. That is the only bound that works on Windows: a pipe write there blocks the thread that
// makes it - the event loop through process.stdout, or a pool thread through fs.write that
// process.exit then joins at shutdown - so no watchdog can interrupt a blocked write (measured on
// both paths). A judge verdict is a few hundred characters (the bundle's own cap is 800), so the
// bound only ever cuts a swapped or damaged bundle's reason. Bytes, not characters: JSON escaping
// doubles a quote or a newline and a non-ASCII character is up to three bytes.
const MAX_DENY_BYTES = 3584;
const TRUNCATION_MARK = " [reason truncated by the hook]";
const CHANNEL = Symbol.for("atbash.hook.answer");

function resolveDeadlineMs(raw) {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DEADLINE_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_DEADLINE_MS || parsed > MAX_DEADLINE_MS) {
    return null;
  }
  return parsed;
}
// Resolved before anything below can run, so no path can reach the drain budget before it exists.
const deadlineMs = resolveDeadlineMs(process.env.ATBASH_HOOK_DEADLINE_MS);

// stdout is the host's decision channel, and only the shim writes to it. The bundled hook hands its
// decision to the shim in-process, through the function installed below under a registered symbol
// (src/hook/protocol.ts HOOK_ANSWER_CHANNEL / deliverDecision): a deny JSON, or "" for a permit.
// Everything the bundle or its libraries write to process.stdout is diverted to stderr (the host
// transcript) - postchain-client's warning() and error() both fire at its default level (LOG_LEVEL
// unset) and a stray line on stdout would corrupt the host's parse. Nothing printed on stdout is
// ever taken for the decision, however well shaped; that residual of a shape check on stdout is
// closed by the channel. The channel accepts exactly one decision: a PreToolUse deny, the object
// serializeDeny emits (tests pin the coupling), and one non-decision: the empty string, the
// bundle's permit. A permit writes nothing (the host's own permission rules and every other hook
// stay in force) and - unlike plain silence, which the exit backstop turns into a deny - it lets
// the process end without a decision; it is not final (a later deny overrides it, the deadline
// still applies). So the channel is a permit primitive for whatever runs in this process, which
// is inside the boundary stated at the top: such code could equally end the process however it
// likes. Anything else on the channel is an invalid decision and is denied - including a deny
// whose reason is not a string.
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
// Set once a queued decision has fully left the process (the write callback ran without error).
let delivered = false;
// Set when this load found the channel taken and refused the call: the exit backstop below then
// belongs to whoever owns the channel, and this load's must stay silent.
let refused = false;
// Set once the bundle's deny has been handed to the thread pool: from then on no other stdout
// write may be attempted (a synchronous write behind a blocked one would block the loop too).
let queued = false;
// Process-wide "a decision is on stdout" marker, shared by every load of this shim in the process:
// a second load that refused the call and wrote the deny must not be followed by the first load's
// backstop deny - two decisions on stdout are unparseable, and on Codex unparseable is a permit.
// In-process code can forge it, which is the same in-process control as everything else here.
const DECIDED_MARK = Symbol.for("atbash.hook.decided");
function decisionOnStdout() {
  return globalThis[DECIDED_MARK] === true;
}
function markDecisionOnStdout() {
  try {
    Object.defineProperty(globalThis, DECIDED_MARK, { value: true, configurable: false });
  } catch {
    // already marked by another load
  }
}

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
  // The bundle's deny goes out as an asynchronous write to file descriptor 1 on the libuv thread
  // pool - never through process.stdout, whose pipe write is synchronous on Windows: a host that
  // does not read blocks that write for every deny larger than the pipe's buffer (64 KiB on a
  // libuv pipe, as little as 4 KiB on a bare CreatePipe), and a blocked event loop can run no
  // watchdog. A blocked pool thread leaves the loop free, so the exit-2 watchdog still ends the
  // process DRAIN_GRACE_MS past the deadline (the same moment the deadline's decided branch would),
  // and a host that reads late still gets every byte. A write error (the host went away) is a
  // blocking exit, never a permit-shaped 0 with the deny lost. The bytes written are the shim's
  // own canonical serialization of the bundle's reason - no sibling key the bundle did not have to
  // prove (an approve-shaped legacy field, say) reaches the host.
  const text = denyJson(JSON.parse(output.trim()).hookSpecificOutput.permissionDecisionReason);
  setTimeout(
    () => exitBlocking("Atbash ERROR: the host did not read the decision in time."),
    drainBudgetMs(),
  ).unref();
  queued = true;
  markDecisionOnStdout();
  writeDecisionAsync(text, (error) => {
    if (error) {
      exitBlocking("Atbash ERROR: the decision could not be delivered to the host.");
      return;
    }
    delivered = true;
    process.exit(0);
  });
}

function writeDecisionAsync(text, callback) {
  // Every byte, off the event loop. On POSIX the pipe behind fd 1 is non-blocking once
  // process.stdout exists, so a full pipe answers EAGAIN: retried on a (referenced) timer, which
  // keeps the loop alive until the host reads or the watchdog decides.
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  const step = () => {
    let request;
    try {
      request = fs.write(1, buffer, offset, buffer.length - offset, null, (error, written) => {
        if (error) {
          if (error.code === "EAGAIN") {
            setTimeout(step, 25);
            return;
          }
          callback(error);
          return;
        }
        offset += written;
        if (offset < buffer.length) {
          step();
          return;
        }
        callback(null);
      });
    } catch (error) {
      callback(error);
    }
    return request;
  };
  step();
}

function drainBudgetMs() {
  // Until DRAIN_GRACE_MS past the deadline (which counts from process start), at least the grace -
  // but never past DRAIN_GRACE_MS after the largest deadline: a decision queued late (the loop was
  // starved by a synchronous hang) is not waited for beyond the host's timeout.
  const budget = deadlineMs === null ? DEFAULT_DEADLINE_MS : deadlineMs;
  const uptimeMs = Math.ceil(process.uptime() * 1000);
  const ceiling = Math.max(0, MAX_DEADLINE_MS + DRAIN_GRACE_MS - uptimeMs);
  return Math.min(Math.max(0, budget - uptimeMs) + DRAIN_GRACE_MS, ceiling);
}
// Set when the stdout pipe reports an error after the bundle's decision was queued (the host went
// away): the decision was lost, and the decided branch below must not end with a permit-shaped 0.
let stdoutBroken = false;

function exitBlocking(reason) {
  // Fail closed the way both hosts honour: a deny on stdout with exit 0. Claude Code also blocks
  // on exit 2, but Codex 0.154.0 does not (measured: exit 2 with a reason on stderr, and even exit
  // 2 with a deny on stdout, let the tool call run; only a deny on stdout with exit 0 blocked it).
  // So the deny goes to stdout synchronously whenever stdout can still take one: not when a
  // decision is already queued on the thread pool (a synchronous write behind a blocked one would
  // block the loop as well, and the host that is not reading gets nothing either way), and not
  // when another load already put a decision there. Only when stdout cannot be written at all is
  // the answer exit 2 with the reason on stderr - blocking for Claude Code, a documented residual
  // for Codex, where a hook whose stdout is gone cannot block anything.
  decided = true;
  if (!queued && !decisionOnStdout()) {
    try {
      writeDecisionSync(denyJson(reason));
      delivered = true;
      markDecisionOnStdout();
      try {
        fs.writeSync(2, reason + "\n");
      } catch {
        // stderr is optional here
      }
      process.exitCode = 0;
      process.exit(0);
      return;
    } catch {
      // stdout is not writable: fall through to the blocking code
    }
  }
  try {
    fs.writeSync(2, reason + "\n");
  } catch {
    // nothing left to report to
  }
  process.exitCode = 2;
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
    // decision stands, and its write is still in flight on the thread pool. If the pipe broke or
    // never drains, exit 2 (a blocking error) rather than a permit-shaped 0 or a wait for the host
    // timeout.
    if (stdoutBroken) {
      exitBlocking(reason);
      return;
    }
    // The queued write's own callback ends the process once every byte is out; this only bounds
    // the wait.
    setTimeout(
      () => exitBlocking("Atbash ERROR: the host did not read the decision in time."),
      drainBudgetMs(),
    ).unref();
    return;
  }
  decided = true;
  try {
    writeDecisionSync(denyJson(reason));
    delivered = true;
    markDecisionOnStdout();
    process.exit(0);
  } catch {
    exitBlocking(reason);
  }
}

function serializeDenyLine(reason) {
  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n"
  );
}

function denyJson(reason) {
  let text = serializeDenyLine(reason);
  let bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_DENY_BYTES) return text;
  // Cut the reason in proportion to the overshoot (the serialized size grows monotonically with
  // the reason), keep a margin for the mark and for escaping, and re-measure; a few rounds settle
  // it, and the last resort is no reason at all.
  let kept = reason;
  for (let round = 0; round < 8 && bytes > MAX_DENY_BYTES; round += 1) {
    const budget = Math.floor((kept.length * MAX_DENY_BYTES) / bytes) - TRUNCATION_MARK.length - 64;
    kept = budget > 0 ? kept.slice(0, budget) : "";
    text = serializeDenyLine(kept + TRUNCATION_MARK);
    bytes = Buffer.byteLength(text, "utf8");
  }
  return bytes <= MAX_DENY_BYTES ? text : serializeDenyLine(TRUNCATION_MARK.trim());
}

// The exit-time backstop, registered before anything below can go wrong. Every fail-closed
// trigger needs an event: a throw, a rejection, a load failure, or the deadline timer - and the
// timer is unref'd so a hook that answered can end. A bundle that simply RETURNS without
// answering (an early return, a swallowed error, a truncated or swapped bundle whose top-level
// call is gone, a library calling process.exit(0)) fires none of them: the loop drains, node
// exits 0 with an empty stdout, and the host reads a permit. So the last word is here: at exit,
// no decision and no permit is a deny written synchronously with exit 0; a decision whose stdout
// write errored (the host went away) or never drained (in-process code ended the process first)
// is a blocking exit code rather than a permit-shaped 0; a permit stays silence. What this cannot
// cover: process.abort or a signal from the native addon ends the process without running exit
// listeners (a non-0/2 exit, which the host treats as non-blocking).
process.on("exit", () => {
  if (refused) return;
  if (decided) {
    // This load's own decision: queued and never confirmed drained, or written synchronously.
    // A decision that was queued but never drained (the host went away, or in-process code called
    // process.exit while the deny was still in the pipe) must not end as a permit-shaped 0 with
    // partial or empty stdout. A blocking exit code is the honest answer.
    if (stdoutBroken || !delivered) process.exitCode = 2;
    return;
  }
  if (permitted) return;
  // Another load of this shim already put the decision on stdout (a refused second load): one
  // decision, not two.
  if (decisionOnStdout()) return;
  decided = true;
  try {
    writeDecisionSync(denyJson("Atbash ERROR: the hook ended without a decision."));
    delivered = true;
    markDecisionOnStdout();
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

// The channel is installed once, by this load, or the tool call is denied. Anything already on
// the channel - a function some preloaded module put there (NODE_OPTIONS=--require, a patched
// host), a second copy of this shim required under another path, a non-function value - means the
// bundle's deny would go to that code, not to the host, so the call is refused here and now. No
// brand or descriptor check can tell the shim's own second load from a decoy that copied it (both
// are in-process code, which could equally patch process.exit), so there is no exemption: a
// second load is a refusal, which fails closed, never a silent permit. The refusal is a deny on
// stdout with exit 0 - the one answer both hosts block on (Codex does not block on exit 2) - and
// the process-wide marker keeps a genuine first load's backstop from adding a second decision.
// Nothing in the plugin loads the shim twice.
try {
  if (globalThis[CHANNEL] !== undefined) {
    refused = true;
    // The refusal is a deny on stdout (exit 0): with process.exit patched away in-process the deny
    // is already on stdout when the loop drains, and the channel owner's backstop - a genuine
    // second load - sees the process-wide marker and adds nothing.
    exitBlocking("Atbash ERROR: the hook's decision channel was already taken.");
  } else {
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
// Skipped once a decision was already made above (a refused channel): with process.exit patched
// away in-process nothing after this point may run - not the guard, not the bundle.
if (!decided) {
  try {
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

if (decided) {
  // The channel was refused above: no deadline, no handlers, no bundle. The deny is on its way.
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
