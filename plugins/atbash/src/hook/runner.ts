import type { Decision, ToolCallInput } from "@atbash/sdk";

import { createAtbashGuard, type ToolCallGuard } from "../atbash/guard.js";
import { buildAtbashContext } from "./context.js";
import { sanitizeReason, type PreToolUseInput } from "./protocol.js";

export const INTERNAL_ATBASH_TOOL_PREFIX = "mcp__atbash__";

export type GuardFactory = () => ToolCallGuard;

export type HookOutcome =
  | { allow: true; source: "atbash" | "internal_bypass" }
  | { allow: false; reason: string; verdict: "HOLD" | "BLOCK" | "ERROR" };

export function isInternalAtbashTool(toolName: string): boolean {
  return toolName.startsWith(INTERNAL_ATBASH_TOOL_PREFIX);
}

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
): Promise<HookOutcome> {
  if (isInternalAtbashTool(input.tool_name)) {
    return { allow: true, source: "internal_bypass" };
  }

  let guard: ToolCallGuard;
  try {
    guard = createGuard();
  } catch {
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
