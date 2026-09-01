import { readHookInput } from "./io.js";
import { parsePreToolUseInput, serializeDeny } from "./protocol.js";
import { evaluatePreToolUse, type GuardFactory } from "./runner.js";

export interface PreToolUseCliDependencies {
  createGuard?: GuardFactory;
}

export async function executePreToolUse(
  rawInput: string,
  dependencies: PreToolUseCliDependencies = {},
): Promise<string> {
  try {
    const input = parsePreToolUseInput(rawInput);
    const outcome = await evaluatePreToolUse(input, dependencies.createGuard);
    return outcome.allow ? "" : serializeDeny(outcome.reason);
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

  if (output !== "") {
    process.stdout.write(`${output}\n`);
  }
}
