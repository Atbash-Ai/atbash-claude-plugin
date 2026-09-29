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
// no hook can help; a refusal whose own write fails is that case whatever the function on the
// channel claims (a mark on a function this load did not install is not evidence, and 0 with an
// empty stdout would be a permit on both hosts), so a genuine first load's deny can sit on stdout
// behind that 2 - a Codex permit - only when process.exit was made a no-op in-process.
// In-process code that makes process.exit THROW ends the hook at node's exit 1
// (non-blocking for the host) whatever the shim does; code that makes it a NO-OP leaves a
// complete deny on stdout with the process alive until the host's timeout (a permit on Claude
// Code), and a second copy of the shim loaded after that deny adds its refusal deny behind it
// (two objects, unparseable, a permit on Codex); code running after the channel exists can mark
// the channel function as decided and silence every later deny (or freeze that function so the
// mark can never be set, which lets a refused second load's deny be followed by the first
// load's backstop deny - two objects, unparseable), exactly as it could call the
// channel's permit or blank fs.writeSync - all of it is the same in-process control as patching
// fs, and out of scope; so is a descriptor layer that lies about the count in a way the shim
// cannot tell from a partial write (writes the bytes and reports fewer, so the overlap is
// written twice - unparseable, exit 0; or writes nothing and reports the full count - an empty
// stdout, exit 0), where a count that is not an integer, negative or larger than the request IS
// caught and ends 2. A pipe write to a host that never reads blocks on Windows for any
// deny larger than the pipe's buffer, and nothing in-process can interrupt it (a blocked event
// loop runs no watchdog; a blocked pool thread is joined by process.exit) - so the deny is bounded
// in serialized BYTES (below) under the smallest buffer a host hands a hook, and the write always
// completes - synchronously, so the decision is out before anything else in the process can run.
// Below that bound - a host pipe smaller than the bound, which no known host hands a hook (libuv
// 64 KiB, a bare CreatePipe 4 KiB) - the write would block and only the host timeout ends it;
// a timeout that is a permit on Claude Code, traded knowingly against the exit-2-behind-a-deny
// permit the asynchronous write caused on Codex (measured on the real host), since no host is
// known to hand a hook such a pipe; measured: a judge-size deny (912 bytes) lands in a 1 KiB pipe.
const fs = require("node:fs");
// The write binding is taken once, here, before anything else in the process can run: the
// bundle (or an instrumenting dependency inside it) replacing fs.writeSync later cannot turn a
// delivered deny into an empty, permit-shaped exit. A preload that replaced it before this line
// is the in-process control listed above.
const writeSync = fs.writeSync;

const DEFAULT_DEADLINE_MS = 28000;
const MIN_DEADLINE_MS = 1000;
// Under the 30 s SDK request budget and 5 s under the host's 35 s timeout: node start-up and the
// bundle load (~0.2 s warm, more under a cold cache or a scanner) must fit inside the margin.
const MAX_DEADLINE_MS = 30000;
// The largest deny written to the host, in serialized bytes: under the smallest pipe buffer a
// host is known to hand a hook (4 KiB for a bare CreatePipe; libuv pipes have 64 KiB), so the
// write always completes into the pipe whether or not the host has read yet, and no host can hold
// it. That is the only bound that works on Windows: a pipe write there blocks the thread that
// makes it - the event loop through process.stdout, or a pool thread through fs.write that
// process.exit then joins at shutdown - so no watchdog can interrupt a blocked write (measured on
// both paths). A judge verdict is a few hundred characters (the bundle's own cap is 800 characters,
// up to about 4.8 KB serialized when every one needs escaping), so the bound cuts a real reason
// only when it is escape-heavy, and a swapped or damaged bundle's reason always; the mark says
// so. Bytes, not characters: JSON escaping
// doubles a quote or a newline and a non-ASCII character is up to three bytes.
const MAX_DENY_BYTES = 3584;
const TRUNCATION_MARK = " [reason truncated by the hook]";
// The synchronous write's time budget. A momentarily full pipe answers EAGAIN (POSIX, where fd 1
// is non-blocking once process.stdout exists) and is retried; a transport that keeps refusing,
// or takes the deny a byte at a time, must not hold the hook past the host's timeout - a hook
// that times out is a permit on both hosts. So the write is bounded twice, in wall-clock time:
// a stall budget - the longest the write may go without a single accepted byte - and an
// absolute give-up (below, two seconds past the configured deadline) past which no retry is
// attempted at all. Both are checked at the top of every loop turn but the first: every write
// gets one attempt whatever the clock says, because a bundle that blocked the event loop past
// the give-up and then answered must still put its deny on a healthy stdout (exit 2 with an
// empty stdout would be a Codex permit). A transport that keeps accepting bytes, however slowly,
// is not stalled and gets the whole deny as long as the give-up allows; one that stops
// accepting for the stall budget, or stalls the first byte, is an error and the hook ends with
// a blocking exit code. Two seconds is generous for a host that is merely slow to drain (the
// deny is bounded under the smallest pipe buffer a host hands a hook and nothing else in the
// process writes to fd 1, so the pipe is empty when the deny arrives).
const WRITE_RETRY_WAIT_MS = 25;
const WRITE_STALL_BUDGET_MS = 2000;
const CHANNEL = Symbol.for("atbash.hook.answer");

function resolveDeadlineMs(raw) {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DEADLINE_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_DEADLINE_MS || parsed > MAX_DEADLINE_MS) {
    return null;
  }
  return parsed;
}
// Resolved before anything below can run, so no path can reach the deadline before it exists.
const deadlineMs = resolveDeadlineMs(process.env.ATBASH_HOOK_DEADLINE_MS);
// The absolute give-up for the deny write: two seconds past the deadline this run was configured
// with (the largest one when the value was invalid - a deny is on its way regardless), inside
// the host's 35 s with room for the exit. A retry never starts after it; a first attempt does,
// and a first attempt that came after it keeps up to one stall budget of retries
// (writeDecisionSync), never past 32 s of uptime - two seconds after the largest deadline, so
// with the largest deadline configured the extension is inert, and a first attempt later than
// 30 s gets only what is left before that ceiling (past it, a single syscall).
const DELIVERY_GIVE_UP_MS = (deadlineMs ?? MAX_DEADLINE_MS) + 2000;

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
// Set when this load found the channel taken and refused the call: the exit backstop below then
// belongs to whoever owns the channel, and this load's must stay silent.
let refused = false;
// "A decision is on stdout", shared by every load of this shim in the process as a property of
// the channel function itself: a second load that refused the call and wrote the deny must not be
// followed by the first load's backstop deny - two decisions on stdout are unparseable, and on
// Codex unparseable is a permit. Living on the channel function, the mark cannot be pre-set by a
// preload on a channel that does not exist yet (the function is created by this load); a load
// that refuses a taken channel never consults the mark, so a forged mark on a foreign function
// cannot silence the refusal either. In-process code that loads a second copy of the shim inside
// the bundle's own turn cannot slip a second decision in while process.exit works: the bundle's
// deny is written synchronously and the process ends right behind it. With process.exit made a
// no-op in-process the second load's refusal deny does follow the first on stdout - two objects,
// unparseable, a Codex permit - and code running after the channel exists can set the mark
// itself and silence every later deny: both are the in-process control listed at the top, out
// of scope. The mark counts only on the channel function THIS load installed: a refused second
// load sets it on the first load's function, which is the one case the first load must honour;
// a mark on any other function (a preloaded decoy, an accessor that read undefined once and a
// marked function afterwards) is not evidence that anything reached the host, and honouring it
// turned the blocking exit into a permit-shaped 0 with an empty stdout. The slot is read
// defensively: an accessor that throws (a preload's) must not end the hook at node's exit 1,
// and for this question an unreadable slot holds no decision.
function decisionOnStdout() {
  try {
    const owner = globalThis[CHANNEL];
    return owner === answer && answer.decided === true;
  } catch {
    return false;
  }
}
function markDecisionOnStdout() {
  try {
    Object.defineProperty(globalThis[CHANNEL], "decided", { value: true });
  } catch {
    // already marked, or the owner is not extensible
  }
}
// Bytes this load has put on stdout synchronously: once any byte is out, no second decision may
// be started (a prefix plus a full object is unparseable), whatever else fails.
let stdoutBytes = 0;

// The bundle's side of the channel.
function answer(output) {
  if (decided) return;
  // Another load of this shim already put a decision on stdout (a refused second load, with
  // process.exit patched away in-process so this load is still running): a late bundle answer
  // must not add a second decision behind it.
  if (decisionOnStdout()) return;
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
  // The bundle's deny is written synchronously to file descriptor 1 and the process ends at once
  // with exit 0: the deny is bounded under the smallest pipe a host hands a hook, so the write
  // completes into the pipe whether or not the host has read yet (a host that reads late gets
  // every byte from the pipe), and the bytes are out in the same turn - nothing that runs
  // afterwards (a library calling process.exit, a second load of the shim) can find a decision
  // that is "queued but not out". An asynchronous write was tried and abandoned: its completion
  // callback never runs when in-process code exits in the same turn, which left a complete deny
  // on stdout behind an exit code of 2 - blocking for Claude Code, a permit on Codex - and a pool
  // thread blocked by a too-small pipe is joined by process.exit anyway. A write error (the host
  // went away) is exit 2, never a permit-shaped 0 with the deny lost. The bytes written are the
  // shim's own canonical serialization of the bundle's reason - no sibling key the bundle did not
  // have to prove (an approve-shaped legacy field, say) reaches the host.
  const text = denyJson(JSON.parse(output.trim()).hookSpecificOutput.permissionDecisionReason);
  try {
    writeDecisionSync(text);
    markDecisionOnStdout();
    process.exit(0);
  } catch {
    exitBlocking("Atbash ERROR: the decision could not be delivered to the host.");
  }
}

function exitBlocking(reason) {
  // Fail closed the way both hosts honour: a deny on stdout with exit 0. Claude Code also blocks
  // on exit 2, but Codex 0.154.0 does not (measured: exit 2 with a reason on stderr, and even exit
  // 2 with a deny on stdout, let the tool call run; only a deny on stdout with exit 0 blocked it).
  // So the deny goes to stdout synchronously whenever stdout can still take one: not when this
  // load already put bytes there, and not when another load already put a decision there. Only
  // when stdout cannot be written at all is
  // the answer exit 2 with the reason on stderr - blocking for Claude Code, a documented residual
  // for Codex, where a hook whose stdout is gone cannot block anything.
  decided = true;
  if (stdoutBytes === 0 && !decisionOnStdout()) {
    try {
      writeDecisionSync(denyJson(reason));
      markDecisionOnStdout();
      try {
        writeSync(2, reason + "\n");
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
    writeSync(2, reason + "\n");
  } catch {
    // nothing left to report to
  }
  // A decision written by another load of this shim is complete on stdout, so the code is 0, the
  // one both hosts block on; 2 when a synchronous write of this load got part way (a prefix plus
  // anything is unparseable) or when nothing could be written at all.
  process.exitCode = decisionOnStdout() && stdoutBytes === 0 ? 0 : 2;
  process.exit(process.exitCode);
}

function writeDecisionSync(output) {
  // Every byte, or an error: a pipe write can be partial, and on POSIX the pipe behind fd 1 is
  // non-blocking once process.stdout exists, so a momentarily full pipe answers EAGAIN - retried
  // within the bounds above rather than treated as a dead host, and never for long enough to
  // outlive the host's timeout. Progress resets the stall clock, so a transport that keeps
  // taking bytes, however slowly, is not a stall; a write that returns nothing is.
  const buffer = Buffer.from(output, "utf8");
  let offset = 0;
  let attempts = 0;
  const firstAttemptMs = Math.ceil(process.uptime() * 1000);
  // The retry window ends at the absolute give-up - or, for a first attempt that itself started
  // after the give-up (a synchronous stall in the bundle that the host's timeout has not ended),
  // one stall budget after that first attempt, so a partial first write gets the same chance to
  // complete as any other. Never past two seconds after the largest deadline: the ceiling a
  // registered hook timeout is measured against.
  const giveUpMs = Math.min(
    Math.max(DELIVERY_GIVE_UP_MS, firstAttemptMs + WRITE_STALL_BUDGET_MS),
    MAX_DEADLINE_MS + 2000,
  );
  let lastProgressMs = firstAttemptMs;
  while (offset < buffer.length) {
    // Every write gets one attempt whatever the clock says: a bundle that blocked the event loop
    // past the give-up (a synchronous stall the host's timeout has not ended yet) must still put
    // its deny on a healthy stdout rather than end 2 with an empty one - a Codex permit. The
    // bounds apply from the second turn on: they cap the retries, never the first syscall.
    if (attempts > 0) {
      const nowMs = Math.ceil(process.uptime() * 1000);
      if (nowMs >= giveUpMs || nowMs - lastProgressMs >= WRITE_STALL_BUDGET_MS) {
        const error = new Error("the decision could not be written within its time budget");
        error.code = "ETIMEDOUT";
        throw error;
      }
    }
    attempts += 1;
    try {
      const remaining = buffer.length - offset;
      const written = writeSync(1, buffer, offset, remaining);
      // Only an integer count of bytes within what was offered is progress. fs.writeSync is the
      // one captured at load, but the descriptor behind it is the host's; a count that is not a
      // number, negative, or larger than the request would otherwise end the loop with the deny
      // unwritten and the exit at 0 - an empty stdout, a Codex permit.
      if (!Number.isInteger(written) || written < 0 || written > remaining) {
        const error = new Error("the decision channel reported an impossible byte count");
        error.code = "EIO";
        throw error;
      }
      if (written > 0) {
        lastProgressMs = Math.ceil(process.uptime() * 1000);
        offset += written;
        stdoutBytes += written;
      } else {
        // Nothing accepted and no error: a refusal in all but name. Waited out like EAGAIN, so a
        // transport that answers 0 does not turn the stall budget into a hot loop of syscalls.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WRITE_RETRY_WAIT_MS);
      }
    } catch (error) {
      if (!(error && error.code === "EAGAIN")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WRITE_RETRY_WAIT_MS);
    }
  }
}

function deny(reason) {
  // A decision is already on its way (and the process ends right behind it): it stands.
  if (decided) return;
  // Another load of this shim already put a decision on stdout (a refused second load): one
  // decision, not two.
  if (decisionOnStdout()) {
    decided = true;
    return;
  }
  decided = true;
  try {
    writeDecisionSync(denyJson(reason));
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
// write errored (the host went away) already ended with a blocking exit code where it happened,
// never a permit-shaped 0; a permit stays silence. What this cannot
// cover: process.abort or a signal from the native addon ends the process without running exit
// listeners (a non-0/2 exit, which the host treats as non-blocking).
process.on("exit", () => {
  if (refused) return;
  if (decided) {
    // This load's decision was written synchronously before anything else could run and the exit
    // code was set with it: 0 for a delivered deny, the one both hosts block on; 2 only when
    // stdout could not take it.
    return;
  }
  if (permitted) return;
  // Another load of this shim already put the decision on stdout (a refused second load): one
  // decision, not two.
  if (decisionOnStdout()) return;
  decided = true;
  try {
    writeDecisionSync(denyJson("Atbash ERROR: the hook ended without a decision."));
    markDecisionOnStdout();
    process.exitCode = 0;
  } catch {
    try {
      writeSync(2, "Atbash ERROR: the hook ended without a decision.\n");
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
  // The slot is read once, defensively: a preload can install an accessor that throws, and a
  // throw out of this guard would end the hook at node's exit 1 - non-blocking for either host.
  // A slot that cannot be read is a slot that is taken.
  let existing;
  try {
    existing = globalThis[CHANNEL];
  } catch {
    existing = null;
  }
  if (existing !== undefined) {
    refused = true;
    // The refusal is a deny on stdout (exit 0), written whatever the owner's function claims: a
    // forged "decided" mark on a foreign function must not silence it. With process.exit patched
    // away in-process the deny is already on stdout when the loop drains; a genuine first load's
    // backstop and channel see the mark this leaves on its function and add nothing.
    refuseChannel();
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

function refuseChannel() {
  const reason = "Atbash ERROR: the hook's decision channel was already taken.";
  decided = true;
  try {
    writeDecisionSync(denyJson(reason));
    markDecisionOnStdout();
    process.exitCode = 0;
  } catch {
    // The refusal could not be written: a blocking exit, whatever the function on the channel
    // claims. Its mark is not this load's evidence (the channel is foreign here by definition,
    // and a preloaded decoy can carry any mark), and 0 with an empty stdout would be a permit on
    // both hosts. That a genuine first load's complete deny can sit on stdout behind this 2 (a
    // Codex permit) needs process.exit made a no-op in-process - the residual the header names.
    process.exitCode = 2;
  }
  try {
    writeSync(2, reason + "\n");
  } catch {
    // nothing left to report to
  }
  process.exit(process.exitCode);
}

// Installing the stdout guard touches process.stdout, which can itself throw when fd 1 is closed at
// spawn (EBADF); that must end as a blocking error, not as node's default exit 1 with no output.
// Skipped once a decision was already made above (a refused channel): with process.exit patched
// away in-process nothing after this point may run - not the guard, not the bundle.
if (!decided) {
  try {
    // Nothing writes to the stream itself (the deny goes to fd 1 directly, every other write is
    // diverted below), so an error event here has no decision to lose; the handler only keeps an
    // unexpected one from ending the hook as an uncaught exception.
    process.stdout.on("error", () => {});
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
