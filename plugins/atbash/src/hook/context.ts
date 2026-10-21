import { basename } from "node:path";

import type { PreToolUseInput } from "./protocol.js";

export function buildAtbashContext(input: PreToolUseInput): string {
  const parts = [
    `source=${input.host === "cursor" ? "cursor" : "claude-code"}`,
    `workspace=${basename(input.cwd) || "unknown"}`,
    `permission_mode=${input.permission_mode}`,
  ];
  if (input.model !== undefined && input.model !== "") {
    parts.push(`model=${input.model}`);
  }
  return parts.join("; ");
}
