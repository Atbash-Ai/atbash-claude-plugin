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

export interface SetupBootstrap {
  hasConfiguration(): boolean;
  isSetupCall(input: PreToolUseInput): boolean;
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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isSetupToolCall(
  input: PreToolUseInput,
  options: SetupBootstrapOptions = {},
): boolean {
  const toolInput = record(input.tool_input);
  if (!toolInput) return false;

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
  };
}
