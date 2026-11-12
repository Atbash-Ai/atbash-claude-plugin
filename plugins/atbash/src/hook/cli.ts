import type { SetupBootstrap } from "./bootstrap.js";
import { readHookInput } from "./io.js";
import { deliverDecision, parsePreToolUseInput, serializeDeny } from "./protocol.js";
import { evaluatePreToolUse, type GuardFactory } from "./runner.js";
import { recordUnenforcedPermit } from "./shadow-log.js";

export interface PreToolUseCliDependencies {
  createGuard?: GuardFactory;
  bootstrap?: SetupBootstrap;
  /** Records a call the organisation's enforcement mode let through; defaults to the shadow log. */
  recordUnenforced?: typeof recordUnenforcedPermit;
}

export async function executePreToolUse(
  rawInput: string,
  dependencies: PreToolUseCliDependencies = {},
): Promise<string> {
  try {
    const input = parsePreToolUseInput(rawInput);
    const outcome = await evaluatePreToolUse(
      input,
      dependencies.createGuard,
      dependencies.bootstrap,
    );
    if (!outcome.allow) return serializeDeny(outcome.reason);
    if (outcome.unenforced !== undefined) {
      // Shadow, monitor or off mode: the call runs, and the user is told what enforcement would
      // have done. The permit is already decided; a record that fails must not turn it into a deny.
      try {
        (dependencies.recordUnenforced ?? recordUnenforcedPermit)(
          outcome.unenforced,
          input.tool_name,
        );
      } catch {
        // the permit stands
      }
    }
    return "";
  } catch {
    return serializeDeny("Atbash ERROR: the hook input was invalid.");
  }
}

export async function runPreToolUseCli(): Promise<void> {
  let output: string;
  try {
    output = await executePreToolUse(await readHookInput(process.stdin));
  } catch {
    output = serializeDeny("Atbash ERROR: the hook input could not be read.");
  }

  // A permit is the empty string: the shim records it (a permit is never final - a later deny
  // overrides it and the deadline still applies) and writes nothing.
  deliverDecision(output);
}
