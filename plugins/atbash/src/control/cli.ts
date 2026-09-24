import {
  cancelControlJob,
  continueControlJob,
  inspectControlJob,
  startControlJob,
  submitControlPlan,
} from "./workflow.js";
import type { ControlHost } from "./protocol.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function host(value: string | undefined): ControlHost {
  if (value !== "codex" && value !== "claude") throw new Error("--host must be codex or claude.");
  return value;
}

export async function runControl(args = process.argv.slice(2)): Promise<unknown> {
  const [area, command, positional] = args;
  if ((area === "setup" || area === "manage") && command === "start") {
    const deviceName = option(args, "--device");
    const serviceOrigin = option(args, "--service");
    return startControlJob({
      host: host(option(args, "--host")),
      purpose: area === "setup" ? "onboard" : "manage",
      ...(deviceName ? { deviceName } : {}),
      ...(serviceOrigin ? { serviceOrigin } : {}),
    });
  }
  if ((area === "setup" || area === "manage") && command === "inspect")
    return inspectControlJob(required(positional, "A job ID is required."));
  if ((area === "setup" || area === "manage") && command === "plan") {
    return submitControlPlan(
      required(positional, "A job ID is required."),
      required(option(args, "--input"), "--input must point to a non-secret plan JSON file."),
    );
  }
  if ((area === "setup" || area === "manage") && command === "continue")
    return continueControlJob(required(positional, "A job ID is required."));
  if ((area === "setup" || area === "manage") && command === "cancel")
    return cancelControlJob(required(positional, "A job ID is required."));
  throw new Error(
    "Usage: control setup|manage start --host codex|claude; inspect <job>; plan <job> --input <file>; continue <job>; cancel <job>",
  );
}
