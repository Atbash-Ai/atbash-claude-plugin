import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getConfigPath, keyPathCandidates } from "@atbash/sdk";

import type { ControlHost } from "../control/protocol.js";
import { configRoot } from "../control/store.js";
import type { PreToolUseInput } from "./protocol.js";

/**
 * Setup bootstrap for an unconfigured install.
 *
 * The guard is fail closed, so before any agent is configured it denies every
 * tool call — including the calls the setup skill needs to create the
 * configuration. While no configuration exists at all, the hook allows only
 * the exact setup steps matched here and keeps denying everything else. Any
 * existing configuration, valid or not, keeps the normal fail-closed path.
 */

export const NOT_SET_UP_REASON =
  "Atbash is not set up yet. Ask Claude to 'Set up Atbash'; until setup finishes, only the Atbash setup steps can run.";

const SETUP_SKILLS = new Set(["atbash:atbash-setup", "atbash-setup"]);
const SETUP_COMMANDS = new Set([
  "setup start",
  "setup inspect",
  "setup plan",
  "setup continue",
  "setup cancel",
  "profile connect",
  "profile list",
  "profile switch",
]);
const UNQUOTED_WORD_CHAR = /^[A-Za-z0-9_./:@=+,%-]$/;
const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\", "\n"]);
const PLAN_FILE = /^[A-Za-z0-9_-]{1,100}\.json$/;
const TASK_OUTPUT_FILE = /^[A-Za-z0-9_-]{1,100}\.output$/;
/**
 * Background-task tools setup mode allows by name alone. None reads a file or
 * runs a command. `TaskStop` stops a task in current Claude Code, which ships it
 * as a deferred tool — callable only after `ToolSearch` loads its schema.
 * `ToolSearch` returns schemas and nothing else, and every tool it loads is
 * still judged here when called. `BashOutput` and `KillShell` are the same two
 * operations under the names older Claude Code versions use.
 */
const SETUP_TASK_TOOLS = new Set(["TaskStop", "ToolSearch", "BashOutput", "KillShell"]);

export interface SetupBootstrap {
  hasConfiguration(): boolean;
  isSetupCall(input: PreToolUseInput): boolean;
  /** The exact plan steps self-protection lets through (see isPlanStep). */
  isPlanStep?(input: PreToolUseInput): boolean;
  /** The exact helper commands self-protection lets through (see isHelperStep). */
  isHelperStep?(input: PreToolUseInput): boolean;
}

export interface SetupBootstrapOptions {
  host?: ControlHost;
  env?: NodeJS.ProcessEnv;
  pluginRoot?: string | undefined;
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function hasUserConfigKey(): boolean {
  const path = getConfigPath();
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { agentKey?: unknown };
    return typeof parsed.agentKey === "string" && parsed.agentKey.trim() !== "";
  } catch {
    // An unreadable config file is a configuration, just an invalid one.
    return true;
  }
}

/** True when any guard configuration source exists, valid or not. */
export function hasAtbashConfiguration(options: SetupBootstrapOptions = {}): boolean {
  const env = options.env ?? process.env;
  if (env.ATBASH_AGENT_KEY?.trim()) return true;
  if (pathExists(join(configRoot(env), "hosts", `${options.host ?? "claude"}.json`))) return true;
  if (hasUserConfigKey()) return true;
  return keyPathCandidates().some(pathExists);
}

/**
 * Split a command into words the way the shell would, returning null for
 * anything beyond plain words and quoting: operators, redirection,
 * expansion, globbing, escapes, comments, and line breaks.
 */
export function splitPlainCommand(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let index = 0;
  while (index < command.length) {
    const char = command[index] as string;
    if (char === " " || char === "\t") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      index += 1;
      continue;
    }
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end === -1) return null;
      const quoted = command.slice(index + 1, end);
      if (hasControlCharacter(quoted)) return null;
      word += quoted;
      inWord = true;
      index = end + 1;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      while (end < command.length && command[end] !== '"') {
        const inner = command[end] as string;
        if (inner === "$" || inner === "`" || hasControlCharacter(inner)) return null;
        if (inner === "\\" && DOUBLE_QUOTE_ESCAPES.has(command[end + 1] ?? "")) return null;
        end += 1;
      }
      if (end >= command.length) return null;
      word += command.slice(index + 1, end);
      inWord = true;
      index = end + 1;
      continue;
    }
    if (!UNQUOTED_WORD_CHAR.test(char)) return null;
    word += char;
    inWord = true;
    index += 1;
  }
  if (inWord) words.push(word);
  return words;
}

function samePath(candidate: string, cwd: string, expected: string): boolean {
  const absolute = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
  return canonical(absolute) === canonical(expected);
}

function isSetupCommand(command: string, cwd: string, pluginRoot: string): boolean {
  const words = splitPlainCommand(command);
  if (!words || words[0] !== "node" || words.length < 2) return false;
  const [, script = "", ...args] = words;
  const launcher = join(pluginRoot, "skills", "atbash-setup", "scripts", "atbash-control.mjs");
  if (!samePath(script, cwd, launcher)) return false;
  const [area, action] = args;
  if (!SETUP_COMMANDS.has(`${area} ${action}`)) return false;
  // A different service origin would pair with an unknown dashboard.
  return !args.some((arg) => arg === "--service" || arg.startsWith("--service="));
}

function isPlanWrite(filePath: string, env: NodeJS.ProcessEnv): boolean {
  if (!isAbsolute(filePath)) return false;
  const plans = join(configRoot(env), "plans");
  try {
    if (lstatSync(plans).isSymbolicLink()) return false;
  } catch {
    // The helper creates the directory; a missing one cannot be a symlink.
  }
  const target = resolve(filePath);
  return dirname(target) === plans && PLAN_FILE.test(basename(target));
}

const PLAN_LAUNCHERS: Readonly<Record<string, string>> = {
  setup: "atbash-setup",
  manage: "atbash-manage",
};
const JOB_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** A plan write that may skip self-protection: a write follows a symlink, so the file must not be one. */
function isPlanFile(filePath: string, env: NodeJS.ProcessEnv): boolean {
  if (!isPlanWrite(filePath, env)) return false;
  try {
    return !lstatSync(resolve(filePath)).isSymbolicLink();
  } catch {
    // A plan the helper has not seen yet is a new file, not a link.
    return true;
  }
}

/** Exactly `node <launcher> setup|manage plan <job-id> --input <plans>/<job-id>.json`, nothing else. */
function isPlanCommand(
  command: string,
  cwd: string,
  pluginRoot: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const words = splitPlainCommand(command);
  if (!words || words.length !== 7 || words[0] !== "node") return false;
  const [, script = "", area = "", action, jobId = "", flag, planPath = ""] = words;
  const skill = PLAN_LAUNCHERS[area];
  if (skill === undefined || action !== "plan" || flag !== "--input") return false;
  if (!JOB_ID.test(jobId) || basename(planPath) !== `${jobId}.json`) return false;
  const launcher = join(pluginRoot, "skills", skill, "scripts", "atbash-control.mjs");
  return samePath(script, cwd, launcher) && isPlanFile(planPath, env);
}

/**
 * The two onboarding steps that touch `<config>/plans/`: writing a plan and handing it to the
 * helper. Self-protection guards the whole Atbash configuration directory, so without this the
 * guided setup and management flows could never submit a plan. A plan is a non-secret proposal
 * the user still signs in the browser; it cannot switch Atbash off or change its key. The call
 * still goes to the judge (or the setup bootstrap) like any other.
 */
export function isPlanStep(input: PreToolUseInput, options: SetupBootstrapOptions = {}): boolean {
  const toolInput = record(input.tool_input);
  if (!toolInput) return false;
  const env = options.env ?? process.env;
  if (input.tool_name === "Write") {
    return typeof toolInput.file_path === "string" && isPlanFile(toolInput.file_path, env);
  }
  if (input.tool_name === "Bash") {
    return (
      options.pluginRoot !== undefined &&
      typeof toolInput.command === "string" &&
      isPlanCommand(toolInput.command, input.cwd, options.pluginRoot, env)
    );
  }
  return false;
}

/**
 * Helper commands, by the skill whose launcher runs them. A real install runs the launcher from
 * `~/.claude/plugins/cache/…`, a path self-protection guards, so without this every setup command
 * was denied as a change to installed Claude Code plugins. The plan commands are plan steps.
 * `profile disconnect` is not here: it switches Atbash off, which is the user's to do.
 */
const HELPER_COMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  "atbash-setup": new Set([
    "setup start",
    "setup inspect",
    "setup continue",
    "setup cancel",
    "profile connect",
    "profile list",
    "profile switch",
  ]),
  "atbash-manage": new Set(["manage start", "manage inspect", "manage continue", "manage cancel"]),
};

/**
 * Exactly `node <the plugin's own launcher> <helper command> [plain arguments]`: the same strict
 * form setup mode accepts, with no `--service`. Running the plugin's own helper cannot switch
 * Atbash off or re-point it, except `profile switch`, which selects another agent; it passes only
 * while no configuration exists. The call is still judged once Atbash is configured.
 */
export function isHelperStep(
  input: PreToolUseInput,
  options: SetupBootstrapOptions = {},
  configured: () => boolean = () => hasAtbashConfiguration(options),
): boolean {
  if (input.tool_name !== "Bash" || options.pluginRoot === undefined) return false;
  const command = record(input.tool_input)?.command;
  if (typeof command !== "string") return false;
  const words = splitPlainCommand(command);
  if (!words || words.length < 4 || words[0] !== "node") return false;
  const [, script = "", area = "", action = "", ...args] = words;
  if (args.some((arg) => arg === "--service" || arg.startsWith("--service="))) return false;
  const name = `${area} ${action}`;
  const pluginRoot = options.pluginRoot;
  const matches = Object.entries(HELPER_COMMANDS).some(
    ([skill, commands]) =>
      commands.has(name) &&
      samePath(
        script,
        input.cwd,
        join(pluginRoot, "skills", skill, "scripts", "atbash-control.mjs"),
      ),
  );
  return matches && (name !== "profile switch" || !configured());
}

/**
 * Claude Code writes a background task's output to
 * `<tmp>/claude/<project>/<session-id>/tasks/<task-id>.output`, named after the
 * session the hook is told about. Requiring that shape, for this session only,
 * is what keeps a setup-mode Read away from everything else on disk — including
 * the credential files setup mode exists to protect.
 */
function isTaskOutputShape(path: string, sessionId: string): boolean {
  const tasks = dirname(path);
  return (
    TASK_OUTPUT_FILE.test(basename(path)) &&
    basename(tasks) === "tasks" &&
    basename(dirname(tasks)) === sessionId
  );
}

function isTaskOutputRead(filePath: string, sessionId: string): boolean {
  if (!isAbsolute(filePath) || sessionId.trim() === "") return false;
  const target = resolve(filePath);
  if (!isTaskOutputShape(target, sessionId)) return false;
  // Judge where the read actually lands, not the name it was asked for: a
  // symlink at this path, or a symlinked directory above it, could otherwise
  // point anywhere. A file that does not exist yet resolves to itself.
  return isTaskOutputShape(canonical(target), sessionId);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isSetupToolCall(
  input: PreToolUseInput,
  options: SetupBootstrapOptions = {},
): boolean {
  // `profile connect` prints the key-import URL and then blocks waiting for the
  // submission, so it runs in the background and the URL lands in that task's
  // output. Without these the assistant cannot read the URL it just caused to
  // be printed, nor stop the task it started, and setup stalls on the user
  // fetching it themselves. Every other call stays denied while setup mode is
  // active, so the tasks these can reach are the ones setup mode permitted.
  if (SETUP_TASK_TOOLS.has(input.tool_name)) return true;

  const toolInput = record(input.tool_input);
  if (!toolInput) return false;

  if (input.tool_name === "Read") {
    return (
      typeof toolInput.file_path === "string" &&
      isTaskOutputRead(toolInput.file_path, input.session_id)
    );
  }

  if (input.tool_name === "Skill") {
    return typeof toolInput.skill === "string" && SETUP_SKILLS.has(toolInput.skill);
  }
  if (input.tool_name === "Bash") {
    return (
      options.pluginRoot !== undefined &&
      typeof toolInput.command === "string" &&
      isSetupCommand(toolInput.command, input.cwd, options.pluginRoot)
    );
  }
  if (input.tool_name === "Write") {
    return (
      typeof toolInput.file_path === "string" &&
      isPlanWrite(toolInput.file_path, options.env ?? process.env)
    );
  }
  return false;
}

/** The plugin root is two levels above the running hook script (runtime/pre-tool-use.cjs). */
export function pluginRootFromEntry(entry = process.argv[1]): string | undefined {
  if (!entry) return undefined;
  try {
    return dirname(dirname(realpathSync(entry)));
  } catch {
    return undefined;
  }
}

export function createSetupBootstrap(options: SetupBootstrapOptions = {}): SetupBootstrap {
  const resolved = { ...options, pluginRoot: options.pluginRoot ?? pluginRootFromEntry() };
  return {
    hasConfiguration: () => hasAtbashConfiguration(resolved),
    isSetupCall: (input) => isSetupToolCall(input, resolved),
    isPlanStep: (input) => isPlanStep(input, resolved),
    isHelperStep: (input) => isHelperStep(input, resolved),
  };
}
