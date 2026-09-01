export class HookProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookProtocolError";
  }
}

export interface PreToolUseInput {
  hook_event_name: "PreToolUse";
  cwd: string;
  permission_mode: string;
  session_id: string;
  tool_input: unknown;
  tool_name: string;
  transcript_path?: string | null;
  model?: string;
  tool_use_id?: string;
  turn_id?: string;
  agent_id?: string;
  agent_type?: string;
}

export interface PreToolUseDenyOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new HookProtocolError(`Hook input field ${key} must be a non-empty string.`);
  }
  return field;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (field === undefined) {
    return undefined;
  }
  if (typeof field !== "string") {
    throw new HookProtocolError(`Hook input field ${key} must be a string when present.`);
  }
  return field;
}

export function parsePreToolUseInput(rawInput: string): PreToolUseInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput) as unknown;
  } catch {
    throw new HookProtocolError("Hook input must be valid JSON.");
  }

  if (!isRecord(parsed)) {
    throw new HookProtocolError("Hook input must be a JSON object.");
  }
  if (parsed.hook_event_name !== "PreToolUse") {
    throw new HookProtocolError("Hook input event must be PreToolUse.");
  }
  if (!Object.hasOwn(parsed, "tool_input")) {
    throw new HookProtocolError("Hook input field tool_input is required.");
  }

  // The permission mode is forwarded to Atbash as judgment context only. It is
  // validated as a non-empty string rather than a closed enum so a new host
  // permission mode does not deny every tool call.
  const permissionMode = requireString(parsed, "permission_mode");

  // Claude Code omits transcript_path in some hook contexts; when present it
  // must be a string or null. The transcript is never read either way.
  const transcriptPath = parsed.transcript_path;
  if (
    transcriptPath !== undefined &&
    transcriptPath !== null &&
    typeof transcriptPath !== "string"
  ) {
    throw new HookProtocolError("Hook input field transcript_path must be a string or null.");
  }

  const model = optionalString(parsed, "model");
  const toolUseId = optionalString(parsed, "tool_use_id");
  const turnId = optionalString(parsed, "turn_id");
  const agentId = optionalString(parsed, "agent_id");
  const agentType = optionalString(parsed, "agent_type");

  return {
    hook_event_name: "PreToolUse",
    cwd: requireString(parsed, "cwd"),
    permission_mode: permissionMode,
    session_id: requireString(parsed, "session_id"),
    tool_input: parsed.tool_input,
    tool_name: requireString(parsed, "tool_name"),
    ...(transcriptPath === undefined ? {} : { transcript_path: transcriptPath }),
    ...(model === undefined ? {} : { model }),
    ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }),
    ...(turnId === undefined ? {} : { turn_id: turnId }),
    ...(agentId === undefined ? {} : { agent_id: agentId }),
    ...(agentType === undefined ? {} : { agent_type: agentType }),
  };
}

export function sanitizeReason(reason: string, fallback: string): string {
  const normalized = reason.replaceAll(/\s+/g, " ").trim();
  const safeReason = normalized.length === 0 ? fallback : normalized;
  return safeReason.slice(0, 800);
}

export function serializeDeny(reason: string): string {
  const output: PreToolUseDenyOutput = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: sanitizeReason(reason, "Atbash denied this tool call."),
    },
  };
  return JSON.stringify(output);
}
