import type { PreToolUseInput } from "./protocol.js";

/** Claude Code's documented permission modes. Any other value is sent as "other". */
const KNOWN_PERMISSION_MODES: ReadonlySet<string> = new Set([
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
]);

/**
 * The shape of a model id: Anthropic ids, Bedrock ids and ARNs, Vertex ids and context-window
 * suffixes such as "[1m]". No spaces, "=", ";" or line breaks, so a value cannot add a fact.
 */
const MODEL_ID = /^[A-Za-z0-9._:/@[\]-]{1,128}$/;

/**
 * The judge context is written to the public chain, so it carries only fixed facts about the
 * host. The working directory is never sent: a folder name can identify a client, and it is
 * free text a cloned repository controls. The permission mode and model also come from the
 * host and can be influenced by repository settings, so each is sent only when it has the
 * expected shape and as "other" otherwise.
 */
export function buildAtbashContext(input: PreToolUseInput): string {
  const permissionMode = KNOWN_PERMISSION_MODES.has(input.permission_mode)
    ? input.permission_mode
    : "other";
  const parts = ["source=claude-code", `permission_mode=${permissionMode}`];
  if (input.model !== undefined && input.model !== "") {
    parts.push(`model=${MODEL_ID.test(input.model) ? input.model : "other"}`);
  }
  return parts.join("; ");
}
