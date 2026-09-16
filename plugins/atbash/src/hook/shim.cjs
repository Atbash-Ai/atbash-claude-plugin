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
// The deny text is fixed here; nothing from the failure is echoed to the host.
const DEFAULT_DEADLINE_MS = 28000;
const MIN_DEADLINE_MS = 1000;
const MAX_DEADLINE_MS = 34000;

let answered = false;
function deny(reason) {
  if (answered) return;
  answered = true;
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
  try {
    process.stdout.write(output + "\n", () => process.exit(0));
  } catch {
    process.exit(0);
  }
  // Belt and braces: if stdout never drains, still leave with 0 (the host treats other codes as
  // a non-blocking error and proceeds).
  setTimeout(() => process.exit(0), 1000).unref();
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
  // unref: a hook that answers normally lets the event loop drain and exits on its own; only a
  // hook still waiting on the judge keeps the loop alive long enough for this to fire.
  setTimeout(() => {
    deny("Atbash ERROR: the safety check did not finish before the host's hook timeout.");
  }, deadlineMs).unref();

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
