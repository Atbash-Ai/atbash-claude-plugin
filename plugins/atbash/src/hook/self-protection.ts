/**
 * Deterministic self-protection: tool calls that would switch Atbash off or re-point it are denied
 * locally, before the judge is asked anything.
 *
 * The judge is a language model. A tricked agent that asks to run `claude plugin disable atbash`,
 * to edit the host's settings or hooks file, to rewrite `~/.config/atbash/config.json`, or to set
 * `ATBASH_ENDPOINT` for a nested session would otherwise be stopped only if the model happened to
 * recognise the request. These checks do not depend on the model: they match the call itself, after
 * undoing the obvious obfuscations (quotes, escapes, case, `bash -c` / `sh -c` / `eval` wrappers,
 * base64 payloads, PowerShell `-EncodedCommand`, symlinked paths).
 *
 * Conservative in both directions:
 *  - reading these files stays allowed: a shell command that names them is denied only when some
 *    part of it is not a known read-only command (with the options that would make even those write
 *    or execute - `sed -i`, `find -exec`, `git -c`, `rg --pre`, an environment prefix - excluded);
 *  - a deny here is final for this attempt, and the reason tells the user to make the change
 *    themselves, outside the agent. A call that passes still goes to the judge as before.
 *
 * What this cannot see: a command that reaches the same files through indirection its text does
 * not show (a script written earlier and run later, a variable assembled piecewise, a repository
 * hook, a tool the host does not route through PreToolUse). Those stay with the judge.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

export interface SelfProtectionContext {
  /** The session's working directory, for relative paths. */
  cwd: string;
  /** The hook's environment: HOME / USERPROFILE / CODEX_HOME / CLAUDE_CONFIG_DIR are read here. */
  env: NodeJS.ProcessEnv;
  /** The OS account's home directory (os.homedir()). */
  homeDir: string;
  /** Directories this plugin runs from; their runtime, hooks and manifest files are protected. */
  pluginRoots: readonly string[];
}

export interface SelfProtectionHit {
  /** What the call would have changed, for the deny reason. */
  target: string;
}

const MAX_TEXT = 65_536;
const MAX_STRINGS = 512;
const MAX_DEPTH = 8;
const MAX_TOKENS = 256;
const MAX_LAYERS = 32;
/** Filesystem lookups (realpath) one call may spend on symlink resolution. */
const MAX_FS_LOOKUPS = 48;

// ---------------------------------------------------------------------------------------------
// The environment this hook runs in.
// ---------------------------------------------------------------------------------------------

/** The plugin roots this hook runs from: the host's variable and the entry script's location. */
export function resolvePluginRoots(
  env: NodeJS.ProcessEnv = process.env,
  entry: string | undefined = process.argv[1],
): string[] {
  const roots: string[] = [];
  for (const value of [env.CLAUDE_PLUGIN_ROOT, env.PLUGIN_ROOT]) {
    if (typeof value === "string" && value.trim() !== "" && isAbsolute(value.trim())) {
      roots.push(value.trim());
    }
  }
  if (typeof entry === "string" && entry !== "") {
    // runtime/pre-tool-use.cjs (shipped) or dist/pre-tool-use.cjs (built for tests): the plugin
    // root is the directory above.
    const dir = dirname(resolvePath(entry));
    if (["runtime", "dist"].includes(basename(dir).toLowerCase())) {
      roots.push(dirname(dir));
    }
  }
  return roots;
}

export function defaultSelfProtectionContext(cwd: string): SelfProtectionContext {
  return { cwd, env: process.env, homeDir: homedir(), pluginRoots: resolvePluginRoots() };
}

// ---------------------------------------------------------------------------------------------
// Path protection.
// ---------------------------------------------------------------------------------------------

interface ProtectedRoot {
  /** Normalized absolute path. */
  path: string;
  /** true: everything under it; false: the file itself. */
  tree: boolean;
  target: string;
}

interface Scope {
  context: SelfProtectionContext;
  roots: ProtectedRoot[];
  /**
   * Deleting or moving a directory that contains a protected file changes that file too, so a
   * path ABOVE a protected root is protected - but only strictly below one of these floors (the
   * home directories, the plugin's parent). `/`, a drive root or the home directory itself are
   * named by too many ordinary commands to be a signal; those stay with the judge.
   */
  floors: string[];
  lookups: number;
  realpaths: Map<string, string | undefined>;
}

/** Lower-case, forward slashes, no duplicate or trailing slash. */
function normalizePath(path: string): string {
  let text = path.replaceAll("\\", "/").toLowerCase();
  text = text.replace(/\/{2,}/g, "/");
  if (text.length > 1 && text.endsWith("/") && !/^[a-z]:\/$/.test(text)) {
    text = text.slice(0, -1);
  }
  return text;
}

/** Every spelling of one absolute path: C:/x, /c/x (Git Bash), /mnt/c/x (WSL), /cygdrive/c/x. */
function pathForms(path: string): string[] {
  const text = normalizePath(path);
  const forms = new Set([text]);
  let match = /^([a-z]):\/(.*)$/.exec(text);
  if (match !== null) {
    const [, drive, rest] = match;
    forms.add(`/${drive}/${rest}`);
    forms.add(`/mnt/${drive}/${rest}`);
    forms.add(`/cygdrive/${drive}/${rest}`);
  }
  match = /^(?:\/mnt|\/cygdrive)?\/([a-z])(?:\/(.*))?$/.exec(text);
  if (match !== null) {
    forms.add(`${match[1]}:/${match[2] ?? ""}`);
  }
  return [...forms];
}

function realpath(path: string, scope: Scope): string | undefined {
  if (scope.realpaths.has(path)) return scope.realpaths.get(path);
  // A UNC path (//server/share, \\server\share) would be a network lookup that can take seconds.
  if (/^[\\/]{2}/.test(path) || scope.lookups <= 0) return undefined;
  scope.lookups -= 1;
  let real: string | undefined;
  try {
    real = realpathSync.native(path);
  } catch {
    real = undefined;
  }
  scope.realpaths.set(path, real);
  return real;
}

function absoluteDirs(values: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "" && isAbsolute(value.trim())) {
      out.push(value.trim());
    }
  }
  return out;
}

function createScope(context: SelfProtectionContext): Scope {
  const scope: Scope = {
    context,
    roots: [],
    floors: [],
    lookups: MAX_FS_LOOKUPS,
    realpaths: new Map(),
  };
  const withReal = (dirs: string[]) => {
    const out = new Set(dirs);
    for (const dir of dirs) {
      const real = realpath(dir, scope);
      if (real !== undefined) out.add(real);
    }
    return [...out];
  };
  const homes = withReal(
    absoluteDirs([context.homeDir, context.env.HOME, context.env.USERPROFILE]),
  );
  const plugins = withReal(absoluteDirs(context.pluginRoots));
  const claudeDirs = [
    ...homes.map((home) => join(home, ".claude")),
    ...absoluteDirs([context.env.CLAUDE_CONFIG_DIR]),
  ];
  const codexDirs = [
    ...homes.map((home) => join(home, ".codex")),
    ...absoluteDirs([context.env.CODEX_HOME]),
  ];
  const add = (path: string, tree: boolean, target: string) => {
    for (const form of pathForms(path)) scope.roots.push({ path: form, tree, target });
  };
  for (const dir of claudeDirs) {
    add(join(dir, "settings.json"), false, "Claude Code settings");
    add(join(dir, "settings.local.json"), false, "Claude Code settings");
    add(join(dir, "plugins"), true, "installed Claude Code plugins");
  }
  for (const dir of codexDirs) {
    add(join(dir, "config.toml"), false, "Codex configuration");
    add(join(dir, "hooks.json"), false, "Codex hooks");
    add(join(dir, "hooks"), true, "Codex hooks");
    add(join(dir, "plugins"), true, "installed Codex plugins");
  }
  for (const home of homes) {
    add(join(home, ".config", "atbash"), true, "the Atbash key and configuration");
    add(join(home, ".cursor", "hooks.json"), false, "Cursor hooks");
  }
  for (const root of plugins) {
    for (const part of ["runtime", "hooks", ".claude-plugin", ".codex-plugin"]) {
      add(join(root, part), true, "the Atbash plugin");
    }
  }
  for (const floor of [
    ...homes,
    ...plugins.map((root) => dirname(root)),
    ...claudeDirs.map((dir) => dirname(dir)),
    ...codexDirs.map((dir) => dirname(dir)),
  ]) {
    scope.floors.push(...pathForms(floor));
  }
  return scope;
}

// Protected wherever they are: project-level host settings and hooks, managed settings, the hosts
// file (which can re-point the judge's hostname), and the Atbash config directory under any HOME.
const ANYWHERE: readonly { test: RegExp; target: string }[] = [
  { test: /(^|\/)\.claude\/settings(\.local)?\.json$/, target: "Claude Code settings" },
  { test: /(^|\/)\.codex\/(config\.toml|hooks\.json)$/, target: "Codex hooks" },
  { test: /(^|\/)\.cursor\/hooks\.json$/, target: "Cursor hooks" },
  { test: /(^|\/)\.config\/atbash(\/|$)/, target: "the Atbash key and configuration" },
  { test: /(^|\/)etc\/(claude-code|codex)(\/|$)/, target: "managed host settings" },
  {
    test: /(^|\/)(programdata|application support)\/(claudecode|claude-code|codex)(\/|$)/,
    target: "managed host settings",
  },
  { test: /(^|\/)managed-settings\.json$/, target: "managed host settings" },
  { test: /(^|\/)etc\/hosts$/, target: "the hosts file (judge address)" },
];

function expandHome(path: string, context: SelfProtectionContext): string {
  const match =
    /^(~|\$home|\$\{home\}|%userprofile%|%home%|\$env:userprofile|\$env:home|\$\{env:userprofile\}|\$\{env:home\})(?=$|[\\/])/i.exec(
      path,
    );
  return match === null ? path : context.homeDir + path.slice(match[0].length);
}

function toAbsolute(path: string, context: SelfProtectionContext): string {
  const expanded = expandHome(path, context);
  if (isAbsolute(expanded) || /^[a-z]:[\\/]/i.test(expanded)) return expanded;
  return join(context.cwd, expanded);
}

function matchPath(absolute: string, scope: Scope, ancestors: boolean): string | undefined {
  for (const form of pathForms(absolute)) {
    for (const rule of ANYWHERE) {
      if (rule.test.test(form)) return rule.target;
    }
    const aboveFloor = ancestors && scope.floors.some((floor) => form.startsWith(`${floor}/`));
    for (const root of scope.roots) {
      if (form === root.path) return root.target;
      if (root.tree && form.startsWith(`${root.path}/`)) return root.target;
      if (aboveFloor && root.path.startsWith(`${form}/`)) return root.target;
    }
  }
  return undefined;
}

/** The path with symlinks resolved on its longest existing prefix (a few levels up at most). */
function resolveLinks(path: string, scope: Scope): string | undefined {
  let current = path;
  const rest: string[] = [];
  for (let level = 0; level < 8; level += 1) {
    const real = realpath(current, scope);
    if (real !== undefined) return join(real, ...[...rest].reverse());
    const parent = dirname(current);
    if (parent === current) return undefined;
    rest.push(basename(current));
    current = parent;
  }
  return undefined;
}

function protectedPathTarget(raw: string, scope: Scope, ancestors: boolean): string | undefined {
  const text = raw.trim();
  if (
    text === "" ||
    text.length > 4096 ||
    text.includes("\0") ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  ) {
    return undefined;
  }
  const absolute = toAbsolute(text, scope.context);
  const direct = matchPath(absolute, scope, ancestors);
  if (direct !== undefined) return direct;
  const linked = resolveLinks(absolute, scope);
  return linked === undefined ? undefined : matchPath(linked, scope, ancestors);
}

// ---------------------------------------------------------------------------------------------
// Shell commands.
// ---------------------------------------------------------------------------------------------

// Plugin and hook switches, on the de-obfuscated, lower-cased text.
const SWITCH_RULES: readonly { pattern: RegExp; target: string }[] = [
  {
    pattern:
      /\bplugins?\s+(?:marketplace\s+)?(?:disable|uninstall|remove|rm|delete)\b[^;|&\n]*atbash/,
    target: "the Atbash plugin",
  },
  { pattern: /\bplugins?\s+disable\b[^;|&\n]*\s(?:--all|-a)\b/, target: "the Atbash plugin" },
  { pattern: /\binstall-hook(?:\.cjs)?\b[^;|&\n]*--uninstall\b/, target: "the Atbash hook" },
  { pattern: /\bfeatures\s+disable\s+\S*hooks\b/, target: "host hooks" },
  { pattern: /\bcodex_hooks\s*=\s*false\b/, target: "host hooks" },
  { pattern: /--disable[\s=]+\S*hooks\b/, target: "host hooks" },
  { pattern: /disableallhooks/, target: "host hooks" },
  { pattern: /\bclaude\s+config\s+(?:set|add|remove|rm|unset)\b/, target: "Claude Code settings" },
];

// The variables Atbash and this hook read (key, organisation, endpoint, verify key, chain switch,
// dev flag, timeouts) and the ones that point a nested host at another configuration. Changing
// them is matched; reading them is not. Other ATBASH_* names (test harness settings) are not ours.
const GUARDED_VARIABLE =
  "(?:atbash_(?:agent_key|org_name|endpoint|judge_verify_pubkey|default_chain_network|dev_allow_local_judge|hook_timeout_ms|hook_deadline_ms|codex_timeout_ms)|claude_config_dir|codex_home)\\b";
const ENV_RULES: readonly RegExp[] = [
  new RegExp(`(?<![\\w$:{])${GUARDED_VARIABLE}\\s*\\+?=(?!=)`),
  new RegExp(`\\$\\{?env:${GUARDED_VARIABLE}\\}?\\s*\\+?=(?!=)`),
  new RegExp(`\\bunset\\b[^;|&\\n]*\\b${GUARDED_VARIABLE}`),
  new RegExp(`\\benv\\b[^;|&\\n]*?(?:\\s-u\\s*|\\s--unset[=\\s]+)${GUARDED_VARIABLE}`),
  new RegExp(`\\bexport\\s+-n\\s+${GUARDED_VARIABLE}`),
  new RegExp(`\\b(?:setx|setenv)\\s+(?:-\\w+\\s+)*${GUARDED_VARIABLE}`),
  new RegExp(`setenvironmentvariable\\s*\\(\\s*${GUARDED_VARIABLE}`),
  new RegExp(
    `\\b(?:remove-item|ri|rm|del|erase|clear-item|clear-content|set-item|si|new-item|ni|rename-item|rni|move-item|mi)\\b[^;|&\\n]*\\benv:[\\\\/]?${GUARDED_VARIABLE}`,
  ),
];

// A directory entered by one command and named relatively by a later one
// (`cd ~/.claude && ... settings.json`): the directory ends a word, a command separator follows,
// and the later name is a whole word of its own (`settings.json`, not `tests/settings.json.ts`).
function enteredThen(dir: string, name: string): RegExp {
  return new RegExp(
    `\\.${dir}\\/?[\\s)]*(?:&&|;|\\|\\||\\n)[\\s\\S]*(?:^|[\\s>=])${name}(?=$|[\\s;|&)])`,
  );
}

// Every spelling a path to a protected file can take inside a command, including relative ones.
const MENTION_RULES: readonly { pattern: RegExp; target: string }[] = [
  { pattern: /\.claude\/settings(?:\.local)?\.json/, target: "Claude Code settings" },
  {
    pattern: enteredThen("claude", "settings(?:\\.local)?\\.json\\b"),
    target: "Claude Code settings",
  },
  { pattern: /\.claude\/plugins\b/, target: "installed Claude Code plugins" },
  { pattern: enteredThen("claude", "plugins\\b"), target: "installed Claude Code plugins" },
  {
    pattern: /\.codex\/(?:config\.toml|hooks\.json|hooks\b|plugins\b)/,
    target: "Codex configuration",
  },
  {
    pattern: enteredThen("codex", "(?:config\\.toml|hooks\\.json|hooks|plugins)\\b"),
    target: "Codex configuration",
  },
  { pattern: /\.cursor\/hooks\.json/, target: "Cursor hooks" },
  { pattern: enteredThen("cursor", "hooks\\.json\\b"), target: "Cursor hooks" },
  { pattern: /\.config\/atbash\b/, target: "the Atbash key and configuration" },
  { pattern: enteredThen("config", "atbash\\b"), target: "the Atbash key and configuration" },
  { pattern: /guard-client-key/, target: "the Atbash key and configuration" },
  { pattern: /managed-settings\.json/, target: "managed host settings" },
  { pattern: /\betc\/(?:claude-code|codex)\b/, target: "managed host settings" },
  { pattern: /(?:^|[\s/"'=])etc\/hosts\b/, target: "the hosts file (judge address)" },
];

// First words of commands that only read, checked with their arguments below. Anything else in a
// command that names a protected file is treated as a possible write.
const READ_ONLY = new Set([
  "cat",
  "type",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "ls",
  "dir",
  "ll",
  "tree",
  "stat",
  "file",
  "wc",
  "diff",
  "cmp",
  "jq",
  "echo",
  "printf",
  "test",
  "[",
  "[[",
  "realpath",
  "readlink",
  "dirname",
  "basename",
  "sha256sum",
  "sha1sum",
  "md5sum",
  "shasum",
  "cksum",
  "hexdump",
  "od",
  "strings",
  "cut",
  "sort",
  "uniq",
  "tr",
  "column",
  "nl",
  "fold",
  "paste",
  "which",
  "printenv",
  "pwd",
  "cd",
  "pushd",
  "popd",
  "sleep",
  "true",
  "false",
  "sed",
  "find",
  "git",
  "get-content",
  "gc",
  "select-string",
  "sls",
  "get-item",
  "gi",
  "get-itemproperty",
  "gp",
  "get-childitem",
  "gci",
  "test-path",
  "resolve-path",
  "rvpa",
  "get-filehash",
  "convertfrom-json",
  "out-string",
  "write-output",
  "write-host",
  // Their script-block forms (`{ ... }`) are refused by the brace rule below.
  "select-object",
  "where-object",
  "sort-object",
  "measure-object",
  "format-list",
  "fl",
  "format-table",
  "ft",
  "env",
]);

const READ_ONLY_GIT = new Set([
  "status",
  "log",
  "diff",
  "show",
  "ls-files",
  "blame",
  "grep",
  "rev-parse",
  "cat-file",
]);

// Shell keywords in front of a command: the command after them is what runs.
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "time"]);
// Headers whose words are data, not a command (`for f in a b`, `case $x in`), and closers.
const HEADERS = new Set(["for", "select", "case", "done", "fi", "esac", "in"]);

function readOnlyArguments(command: string, args: readonly string[]): boolean {
  const positional = args.filter((arg) => !arg.startsWith("-"));
  switch (command) {
    case "sed":
      // Printing a line range is the read; -i/-f, and the w/e commands a script could carry, are not.
      return (
        !args.some((arg) => /^-[a-z]*[if]|^--(in-place|file)/.test(arg)) &&
        positional.length > 0 &&
        /^[\d,$]*p$/.test(positional[0] ?? "")
      );
    case "find":
      return !args.some((arg) =>
        /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg),
      );
    case "sort":
    case "tree":
      return !args.some((arg) => /^-o|^--output/.test(arg));
    case "uniq":
      return positional.length <= 1;
    case "rg":
      return !args.some((arg) => /^--pre\b/.test(arg));
    case "env":
      // Bare `env` prints the environment; with arguments it runs a command.
      return args.length === 0;
    case "git": {
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index] ?? "";
        // -c name=value / --config-env inject configuration (a pager, an external diff, an alias to
        // a shell). The text is lower-cased, so -C <dir> is told apart by its value having no `=`.
        if (/^(--config-env|--exec-path|--output|--ext-diff|--textconv)/.test(arg)) return false;
        if (/^-c./.test(arg) || (arg === "-c" && (args[index + 1] ?? "").includes("="))) {
          return false;
        }
        if (/^(-c|--git-dir|--work-tree|--namespace)$/.test(arg)) {
          index += 1;
          continue;
        }
        if (arg.startsWith("-")) continue;
        return READ_ONLY_GIT.has(arg) && !args.slice(index + 1).some((a) => /^--output/.test(a));
      }
      return false;
    }
    default:
      return true;
  }
}

function isReadOnlySegment(segment: string): boolean {
  if (/>/.test(segment)) return false;
  // A live brace is a PowerShell script block (delay-bound parameters run it) or a shell group or
  // function body; `${var}` is not one, and brace expansion `{a,b}` only lists names.
  if (/(?<!\$)\{/.test(segment.replace(/\{[^{}\s;|&]*,[^{}\s;|&]*\}/g, ""))) return false;
  const words = segment
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  let index = 0;
  while (index < words.length && KEYWORDS.has(words[index] ?? "")) index += 1;
  if (index >= words.length || HEADERS.has(words[index] ?? "")) return true;
  // A plain assignment statement reads nothing and runs nothing; an assignment in front of a
  // command changes how that command behaves (LESSOPEN, GIT_EXTERNAL_DIFF, LD_PRELOAD).
  let assignments = 0;
  while (index < words.length && /^[a-z_][a-z0-9_]*=/.test(words[index] ?? "")) {
    index += 1;
    assignments += 1;
  }
  if (index >= words.length) return true;
  if (assignments > 0) return false;
  const word = (words[index] ?? "").replace(/\.exe$/, "");
  // A path in front of the name is somebody's own `cat`, unless it is a system directory.
  const name = word.includes("/")
    ? /^\/(usr\/)?(local\/)?bin\/[^/]+$/.test(word)
      ? basename(word)
      : ""
    : word;
  if (!READ_ONLY.has(name)) return false;
  return readOnlyArguments(name, words.slice(index + 1));
}

function isReadOnlyCommand(text: string): boolean {
  const withoutSinks = text
    .replace(/[0-9&]?>>?\s*(?:\/dev\/null|nul|\$null)(?=$|[\s;|&)])/g, " ")
    .replace(/[0-9]?>&[0-9]/g, " ");
  return withoutSinks.split(/\|\||&&|[;|&\n()`]|\$\(/).every(isReadOnlySegment);
}

/**
 * The command with operators inside quotes blanked, so `grep "a|b" file` and a path with `(3)` in
 * it are one segment - while `$(...)` and backticks inside double quotes stay live, as they run.
 * When in doubt it leaves an operator live: an extra segment can only make the command look less
 * read-only, never more.
 */
function maskQuotedOperators(text: string): string {
  const operator = /[;|&()<>{}\n]/;
  let out = "";
  let quote: "'" | '"' | null = null;
  let live = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (quote === null) {
      if (char === "\\" && next !== "") {
        out += char + (operator.test(next) ? " " : next);
        index += 1;
      } else {
        if (char === "'" || char === '"') quote = char;
        out += char;
      }
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      out += operator.test(char) ? " " : char;
      continue;
    }
    // Inside double quotes.
    if (live > 0) {
      if (char === "(") live += 1;
      if (char === ")") live -= 1;
      out += char;
      continue;
    }
    if (char === "\\" && next !== "") {
      out += char + (operator.test(next) ? " " : next);
      index += 1;
    } else if (char === "$" && next === "(") {
      live = 1;
      out += "$(";
      index += 1;
    } else if (char === "`") {
      // A backtick substitution (or PowerShell's escape): everything up to the closing quote is
      // treated as live.
      live = Number.POSITIVE_INFINITY;
      out += char;
    } else if (char === '"') {
      quote = null;
      out += char;
    } else {
      out += operator.test(char) ? " " : char;
    }
  }
  return out;
}

/** base64 / base64url tokens that decode to mostly printable text. */
function decodedPayloads(text: string): string[] {
  const out: string[] = [];
  const tokens = text.match(/[A-Za-z0-9+/_-]{12,}={0,2}/g) ?? [];
  for (const token of tokens.slice(0, 32)) {
    const buffer = Buffer.from(token.replaceAll("-", "+").replaceAll("_", "/"), "base64");
    if (buffer.length < 6) continue;
    // PowerShell -EncodedCommand is UTF-16LE.
    const zeroes = buffer.filter((byte, i) => i % 2 === 1 && byte === 0).length;
    const decoded =
      zeroes * 2 >= buffer.length * 0.8 ? buffer.toString("utf16le") : buffer.toString("utf8");
    const printable = [...decoded].filter((c) => /[\x20-\x7e\t\r\n]/.test(c)).length;
    if (printable >= decoded.length * 0.9) out.push(decoded);
  }
  return out;
}

/** \xHH, \uHHHH and \NNN escapes, as `$'...'`, printf and echo -e would expand them. */
function unescape(text: string): string {
  return text
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\0?([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

interface CommandForm {
  /** Quotes and escapes removed, backslashes as slashes: for paths. */
  path: string;
  /** Quotes and escapes removed, backslashes dropped: for words (`cl\aude`). */
  word: string;
  /** Operators inside quotes blanked: for splitting into commands. */
  segments: string;
}

/** The command in every form the checks read: as written, unescaped, and base64-decoded. */
function commandForms(command: string): CommandForm[] {
  const raw = command.slice(0, MAX_TEXT);
  const layers = [raw, unescape(raw)];
  for (let depth = 0, frontier = [...layers]; depth < 2; depth += 1) {
    const next = frontier.flatMap((layer) => decodedPayloads(layer)).slice(0, MAX_LAYERS);
    layers.push(...next, ...next.map(unescape));
    frontier = next;
  }
  const seen = new Set<string>();
  const forms: CommandForm[] = [];
  for (const layer of layers.slice(0, MAX_LAYERS)) {
    if (seen.has(layer)) continue;
    seen.add(layer);
    // Quotes, PowerShell's backtick and cmd's caret escape, and ANSI-C `$'` openers are removed so
    // `cl""aude`, `c\`laude` and `c^laude` read as `claude`.
    const strip = (text: string) =>
      text
        .toLowerCase()
        .replace(/\$'/g, "")
        .replace(/["'`^]/g, "");
    const unquoted = strip(layer);
    forms.push({
      path: unquoted.replaceAll("\\", "/").replace(/\/{2,}/g, "/"),
      word: unquoted.replaceAll("\\", ""),
      segments: maskQuotedOperators(layer)
        .toLowerCase()
        .replace(/\$'/g, "")
        .replace(/["'^]/g, "")
        .replaceAll("\\", "/"),
    });
  }
  return forms;
}

function pathTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const token of text.split(/[\s;|&<>()]+/)) {
    if (tokens.length >= MAX_TOKENS) break;
    if (token === "" || (token.startsWith("-") && !token.includes("="))) continue;
    const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
    if (value === "" || value.includes("*") || value.includes("?")) continue;
    if (!/[/.~]/.test(value) && !/^\$|%/.test(value)) continue;
    tokens.push(value);
  }
  return tokens;
}

function checkCommand(command: string, scope: Scope): SelfProtectionHit | undefined {
  const forms = commandForms(command);
  for (const form of forms) {
    for (const text of [form.path, form.word]) {
      for (const rule of SWITCH_RULES) {
        if (rule.pattern.test(text)) return { target: rule.target };
      }
      for (const rule of ENV_RULES) {
        if (rule.test(text)) return { target: "an Atbash or host configuration variable" };
      }
    }
  }
  for (const form of forms) {
    // Only a command that could write needs to know whether it names a protected file.
    if (isReadOnlyCommand(form.segments)) continue;
    for (const rule of MENTION_RULES) {
      if (rule.pattern.test(form.path) || rule.pattern.test(form.word)) {
        return { target: rule.target };
      }
    }
    for (const token of pathTokens(form.path)) {
      const target = protectedPathTarget(token, scope, true);
      if (target !== undefined) return { target };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Tool inputs.
// ---------------------------------------------------------------------------------------------

const COMMAND_KEYS = new Set([
  "command",
  "cmd",
  "commands",
  "script",
  "shell_command",
  "input_command",
]);
const PATH_KEYS = new Set([
  "file_path",
  "filepath",
  "path",
  "paths",
  "notebook_path",
  "target_file",
  "target",
  "destination",
  "dest",
  "source",
  "src",
  "new_path",
  "old_path",
  "from",
  "to",
  "file",
  "filename",
  "directory",
  "dir",
]);
const SHELL_TOOLS =
  /^(bash|powershell|pwsh|shell|sh|zsh|cmd|terminal|exec|exec_command|local_shell|run_shell_command|run_terminal_cmd|execute_command|run_command)$/;
const WRITE_TOOLS =
  /^(write|edit|multiedit|notebookedit|apply_patch|create|str_replace_editor|str_replace_based_edit_tool)$|write|edit|creat|delet|remov|move|renam|patch|replac|insert|updat|append|upload|save|mkdir|chmod|chown|symlink|link|copy|truncat|put|set/;

interface Collected {
  commands: string[];
  paths: string[];
  patches: string[];
}

function collect(value: unknown, key: string, out: Collected, depth: number): void {
  if (out.commands.length + out.paths.length + out.patches.length >= MAX_STRINGS) return;
  if (depth > MAX_DEPTH) return;
  if (typeof value === "string") {
    const text = value.slice(0, MAX_TEXT);
    if (COMMAND_KEYS.has(key)) out.commands.push(text);
    if (PATH_KEYS.has(key)) out.paths.push(text);
    if (/^\*\*\* (?:begin patch|update file:|add file:|delete file:|move to:)/im.test(text)) {
      out.patches.push(text);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (COMMAND_KEYS.has(key) && value.every((item) => typeof item === "string")) {
      out.commands.push(value.join(" ").slice(0, MAX_TEXT));
    }
    for (const item of value.slice(0, MAX_STRINGS)) collect(item, key, out, depth + 1);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [childKey, child] of Object.entries(value).slice(0, MAX_STRINGS)) {
      collect(child, childKey.toLowerCase(), out, depth + 1);
    }
  }
}

function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const match of patch.matchAll(
    /^\*\*\* (?:update file|add file|delete file|move to):\s*(.+?)\s*$/gim,
  )) {
    if (match[1] !== undefined) paths.push(match[1]);
  }
  for (const match of patch.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(.+?)\s*$/gm)) {
    if (match[1] !== undefined && match[1] !== "/dev/null") paths.push(match[1]);
  }
  return paths;
}

/**
 * The target this call would disable or modify, or undefined when the call does not touch Atbash's
 * own controls. Throws only on a bug; the caller denies on a throw.
 */
export function checkSelfProtection(
  toolName: string,
  toolInput: unknown,
  context: SelfProtectionContext,
): SelfProtectionHit | undefined {
  const name = toolName.toLowerCase();
  const leaf = name.split(/__|\./).pop() ?? name;
  const out: Collected = { commands: [], paths: [], patches: [] };
  if (typeof toolInput === "string" && SHELL_TOOLS.test(leaf)) {
    out.commands.push(toolInput.slice(0, MAX_TEXT));
  }
  collect(toolInput, "", out, 0);
  const writes = WRITE_TOOLS.test(leaf);
  if (out.commands.length === 0 && out.patches.length === 0 && !(writes && out.paths.length > 0)) {
    return undefined;
  }

  const scope = createScope(context);
  for (const command of out.commands) {
    const hit = checkCommand(command, scope);
    if (hit !== undefined) return hit;
  }
  if (writes) {
    for (const path of out.paths) {
      const target = protectedPathTarget(path, scope, true);
      if (target !== undefined) return { target };
    }
  }
  for (const patch of out.patches) {
    for (const path of patchPaths(patch)) {
      const target = protectedPathTarget(path, scope, true);
      if (target !== undefined) return { target };
    }
  }
  return undefined;
}

export function selfProtectionReason(hit: SelfProtectionHit): string {
  return (
    `Atbash BLOCK: this call would disable or change ${hit.target}. ` +
    "An agent may not switch off or re-point its own safety controls; make this change yourself, outside the agent."
  );
}
