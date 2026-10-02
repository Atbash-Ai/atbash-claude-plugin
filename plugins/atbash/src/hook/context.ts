import { basename } from "node:path";

import type { CallOrigin } from "./call-origin.js";
import type { PreToolUseInput } from "./protocol.js";

/**
 * The fact sent when the call's instruction appears to come from tool output. A fixed sentence:
 * no transcript text ever leaves the machine. "unknown" adds nothing, so the context is unchanged.
 */
export const CALL_ORIGIN_TOOL_OUTPUT =
  "call_origin=tool_output (the instruction for this call appeared in a tool output, not in the user request)";

export function buildAtbashContext(input: PreToolUseInput, origin: CallOrigin = "unknown"): string {
  const parts = [
    "source=claude-code",
    `workspace=${basename(input.cwd) || "unknown"}`,
    `permission_mode=${input.permission_mode}`,
  ];
  if (input.model !== undefined && input.model !== "") {
    parts.push(`model=${input.model}`);
  }
  if (origin === "tool_output") {
    parts.push(CALL_ORIGIN_TOOL_OUTPUT);
  }
  return parts.join("; ");
}
