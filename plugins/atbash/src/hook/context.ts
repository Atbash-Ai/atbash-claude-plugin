import { basename } from "node:path";

import type { PreToolUseInput } from "./protocol.js";

export function buildAtbashContext(input: PreToolUseInput): string {
  return [
    "source=codex",
    `workspace=${basename(input.cwd) || "unknown"}`,
    `model=${input.model}`,
    `permission_mode=${input.permission_mode}`,
  ].join("; ");
}
