import type { Decision, ToolCallInput } from "@atbash/sdk";

import { createAtbashGuard, type ToolCallGuard } from "../atbash/guard.js";
import { createSetupBootstrap, NOT_SET_UP_REASON, type SetupBootstrap } from "./bootstrap.js";
import { buildAtbashContext } from "./context.js";
import { sanitizeReason, type PreToolUseInput } from "./protocol.js";

export type GuardFactory = () => ToolCallGuard;

export type HookOutcome =
  | { allow: true; source: "atbash" | "setup-bootstrap" }
  | { allow: false; reason: string; verdict: "HOLD" | "BLOCK" | "ERROR" };

function formatReference(toolCallId: string | undefined): string {
  if (toolCallId === undefined || toolCallId.trim() === "") {
    return "";
  }
  return ` Reference: ${toolCallId.trim().slice(0, 200)}.`;
}

function denyFromDecision(decision: Decision): HookOutcome {
  const verdict =
    decision.verdict === "HOLD" || decision.verdict === "BLOCK" ? decision.verdict : "ERROR";
  const fallback =
    verdict === "HOLD"
      ? "Atbash held this action for operator review."
      : verdict === "BLOCK"
        ? "Atbash blocked this action."
        : "Atbash could not produce a safe decision.";
  const reason = sanitizeReason(decision.reason ?? "", fallback);

  return {
    allow: false,
    verdict,
    reason: `Atbash ${verdict}: ${reason}${formatReference(decision.toolCallId)}`,
  };
}

export async function evaluatePreToolUse(
  input: PreToolUseInput,
  createGuard: GuardFactory = createAtbashGuard,
  bootstrap: SetupBootstrap = createSetupBootstrap(),
): Promise<HookOutcome> {
  let guard: ToolCallGuard;
  try {
    guard = createGuard();
  } catch {
    // Only a missing configuration enters setup mode; an invalid one stays fail closed.
    if (!bootstrap.hasConfiguration()) {
      return bootstrap.isSetupCall(input)
        ? { allow: true, source: "setup-bootstrap" }
        : { allow: false, verdict: "ERROR", reason: NOT_SET_UP_REASON };
    }
    return {
      allow: false,
      verdict: "ERROR",
      reason: "Atbash ERROR: configuration is missing or invalid.",
    };
  }

  const toolCall: ToolCallInput = {
    toolName: input.tool_name,
    args: input.tool_input,
    context: buildAtbashContext(input),
  };

  let decision: Decision;
  try {
    decision = await guard.auditToolCall(toolCall);
  } catch {
    return {
      allow: false,
      verdict: "ERROR",
      reason: "Atbash ERROR: the safety check failed before a decision was returned.",
    };
  }

  if (decision.allow === true && decision.verdict === "ALLOW") {
    return { allow: true, source: "atbash" };
  }

  return denyFromDecision(decision);
}
