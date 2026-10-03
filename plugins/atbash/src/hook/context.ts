import type { PreToolUseInput } from "./protocol.js";

/**
 * The judge context is written to the public chain, so it carries only fixed facts about the
 * host. The working directory is never sent: a folder name can identify a client, and it is
 * free text a cloned repository controls.
 */
export function buildAtbashContext(input: PreToolUseInput): string {
  const parts = ["source=claude-code", `permission_mode=${input.permission_mode}`];
  if (input.model !== undefined && input.model !== "") {
    parts.push(`model=${input.model}`);
  }
  return parts.join("; ");
}
