const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
]);

export class HookProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookProtocolError";
  }
}

export interface PreToolUseInput {
  hook_event_name: "PreToolUse";
  cwd: string;
  model: string;
  permission_mode: string;
  session_id: string;
  tool_input: unknown;
  tool_name: string;
  tool_use_id: string;
  transcript_path: string | null;
  turn_id: string;
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

  const permissionMode = requireString(parsed, "permission_mode");
  if (!PERMISSION_MODES.has(permissionMode)) {
    throw new HookProtocolError("Hook input field permission_mode is invalid.");
  }

  const transcriptPath = parsed.transcript_path;
  if (transcriptPath !== null && typeof transcriptPath !== "string") {
    throw new HookProtocolError("Hook input field transcript_path must be a string or null.");
  }

  const agentId = parsed.agent_id;
  const agentType = parsed.agent_type;
  if (agentId !== undefined && typeof agentId !== "string") {
    throw new HookProtocolError("Hook input field agent_id must be a string when present.");
  }
  if (agentType !== undefined && typeof agentType !== "string") {
    throw new HookProtocolError("Hook input field agent_type must be a string when present.");
  }

  return {
    hook_event_name: "PreToolUse",
    cwd: requireString(parsed, "cwd"),
    model: requireString(parsed, "model"),
    permission_mode: permissionMode,
    session_id: requireString(parsed, "session_id"),
    tool_input: parsed.tool_input,
    tool_name: requireString(parsed, "tool_name"),
    tool_use_id: requireString(parsed, "tool_use_id"),
    transcript_path: transcriptPath,
    turn_id: requireString(parsed, "turn_id"),
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
