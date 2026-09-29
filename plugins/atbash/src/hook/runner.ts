import type { Decision, ToolCallInput } from "@atbash/sdk";

import { createAtbashGuard, GuardConfigError, type ToolCallGuard } from "../atbash/guard.js";
import { buildAtbashContext } from "./context.js";
import { sanitizeReason, type PreToolUseInput } from "./protocol.js";
import {
  checkSelfProtection,
  defaultSelfProtectionContext,
  selfProtectionReason,
  type SelfProtectionContext,
  type SelfProtectionHit,
} from "./self-protection.js";

export type GuardFactory = () => ToolCallGuard;

export type HookOutcome =
  | { allow: true; source: "atbash" }
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
  protection: SelfProtectionContext = defaultSelfProtectionContext(input.cwd),
): Promise<HookOutcome> {
  // Local and deterministic, before the judge or even the configuration: a call that would switch
  // Atbash off or re-point it is denied whatever the judge would say, and whether or not Atbash is
  // configured. A failure of the check itself is a deny, never a pass to the judge.
  let hit: SelfProtectionHit | undefined;
  try {
    hit = checkSelfProtection(input.tool_name, input.tool_input, protection);
  } catch {
    return {
      allow: false,
      verdict: "ERROR",
      reason: "Atbash ERROR: the local self-protection check failed.",
    };
  }
  if (hit !== undefined) {
    return { allow: false, verdict: "BLOCK", reason: selfProtectionReason(hit) };
  }

  let guard: ToolCallGuard;
  try {
    guard = createGuard();
  } catch (error) {
    return {
      allow: false,
      verdict: "ERROR",
      reason:
        error instanceof GuardConfigError
          ? error.message
          : "Atbash ERROR: configuration is missing or invalid.",
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
