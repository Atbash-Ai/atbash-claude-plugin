/**
 * Deterministic self-protection: tool calls that would switch Atbash off or re-point it are denied
 * locally, before the judge is asked anything.
 *
 * The judge is a language model. A tricked agent that asks to run `claude plugin disable atbash`,
 * to edit the host's settings or hooks file, to rewrite `~/.config/atbash/config.json`, or to set
 * `ATBASH_ENDPOINT` for a nested session would otherwise be stopped only if the model happened to
 * recognise the request. These checks do not depend on the model: they match the call itself, after
 * undoing the obvious obfuscations (quotes, escapes, case, `bash -c` / `sh -c` / `eval` wrappers,
 * base64 payloads, reversed text, PowerShell `-EncodedCommand`, globs and brace lists, `\\?\` and
 * NTFS stream spellings, symlinked paths).
 *
 * Conservative in both directions:
 *  - reading these files stays allowed: a shell command that names them is denied only when some
 *    part of it is not a known read-only command (with the options that would make even those write
 *    or execute - `sed -i`/`-e`/`w`, `find -exec`, `git -c`, `git --ext-diff`, `rg --pre`, an
 *    environment prefix, a script block - excluded);
 *  - an input the check cannot fully read (too long, too deep, too many tokens or lookups) is a
 *    deny, never a pass: a limit is not a way around the check;
 *  - a deny here is final for this attempt, and the reason tells the user to make the change
 *    themselves, outside the agent. A call that passes still goes to the judge as before.
 *
 * What this cannot see: a command that reaches the same files through indirection its text does
 * not show (a script written earlier and run later, a path assembled by string concatenation, a
 * repository hook, a tool the host does not route through PreToolUse). Those stay with the judge.
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

/** The longest command or path the check reads; a longer one is denied, not skipped. */
const MAX_TEXT = 262_144;
const MAX_STRINGS = 4096;
const MAX_DEPTH = 32;
const MAX_TOKENS = 4096;
const MAX_LAYERS = 128;
const MAX_EXPANSIONS = 64;
/** Filesystem lookups (realpath) one call may spend on symlink resolution. */
const MAX_FS_LOOKUPS = 4096;

const OVER_LIMIT: SelfProtectionHit = { target: "an input too large or too deep to check" };

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
  /** A limit was reached: the call is denied rather than half-checked. */
  exhausted: boolean;
  realpaths: Map<string, string | undefined>;
}

/**
 * One spelling for every way Windows lets a path name the same file: forward slashes, lower case,
 * no `\\?\` / `\\.\` / `\??\` prefix, no NTFS stream suffix (`settings.json::$DATA` writes the file
 * itself; any `:stream` is dropped too), no trailing dots or spaces on a component, no duplicate
 * or trailing slash.
 */
function normalizePath(path: string): string {
  let text = path.replaceAll("\\", "/").toLowerCase();
  text = text.replace(/^\/\/[?.]\/unc\//, "//").replace(/^\/\/[?.]\/|^\/\?\?\/|^\/[?.]\//, "");
  text = text.replace(/\/{2,}/g, "/");
  const parts = text.split("/").map((part, index) => {
    let value = part;
    const colon = value.indexOf(":");
    if (colon >= 0 && !(index === 0 && /^[a-z]:$/.test(value.slice(0, colon + 1)))) {
      value = value.slice(0, colon);
    }
    if (!/^\.+$/.test(value)) value = value.replace(/[. ]+$/, "");
    return value;
  });
  text = parts.join("/");
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

/** The path as the filesystem should be asked about it: prefixes and stream suffixes removed. */
function fsPath(path: string): string {
  let text = path.replace(/^[\\/]{2}[?.][\\/](?:unc[\\/])?|^[\\/]\?\?[\\/]/i, (m) =>
    /unc/i.test(m) ? "\\\\" : "",
  );
  // A stream suffix on the last component (`x.json::$DATA`, `x.json:alt`).
  text = text.replace(/([^\\/:]):[^\\/]*$/, "$1");
  return text;
}

function realpath(path: string, scope: Scope): string | undefined {
  const target = fsPath(path);
  if (scope.realpaths.has(target)) return scope.realpaths.get(target);
  // A UNC path would be a network lookup that can take seconds; it is matched by name only.
  if (/^[\\/]{2}/.test(target)) return undefined;
  if (scope.lookups <= 0) {
    scope.exhausted = true;
    return undefined;
  }
  scope.lookups -= 1;
  let real: string | undefined;
  try {
    real = realpathSync.native(target);
  } catch {
    real = undefined;
  }
  scope.realpaths.set(target, real);
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
    exhausted: false,
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

/**
 * Protected wherever they are: host settings, plugins and hooks at any level (user, project,
 * CLAUDE_CONFIG_DIR / CODEX_HOME), managed settings, the hosts file (which can re-point the judge's
 * hostname), and the Atbash config directory under any HOME. Each pattern is a list of path
 * components; `tree` means anything below the last component is protected too.
 */
const ANYWHERE: readonly { parts: readonly string[]; tree: boolean; target: string }[] = [
  { parts: [".claude", "settings.json"], tree: false, target: "Claude Code settings" },
  { parts: [".claude", "settings.local.json"], tree: false, target: "Claude Code settings" },
  { parts: [".claude", "plugins"], tree: true, target: "installed Claude Code plugins" },
  { parts: [".codex", "config.toml"], tree: false, target: "Codex configuration" },
  { parts: [".codex", "hooks.json"], tree: false, target: "Codex hooks" },
  { parts: [".codex", "hooks"], tree: true, target: "Codex hooks" },
  { parts: [".codex", "plugins"], tree: true, target: "installed Codex plugins" },
  { parts: [".cursor", "hooks.json"], tree: false, target: "Cursor hooks" },
  { parts: [".config", "atbash"], tree: true, target: "the Atbash key and configuration" },
  { parts: ["etc", "claude-code"], tree: true, target: "managed host settings" },
  { parts: ["etc", "codex"], tree: true, target: "managed host settings" },
  { parts: ["programdata", "claudecode"], tree: true, target: "managed host settings" },
  { parts: ["application support", "claudecode"], tree: true, target: "managed host settings" },
  { parts: ["managed-settings.json"], tree: false, target: "managed host settings" },
  { parts: ["etc", "hosts"], tree: false, target: "the hosts file (judge address)" },
];

interface PartMatcher {
  (candidate: string): boolean;
  /** How many characters of the pattern are literal (not glob syntax). */
  literal: number;
}

function withLiteral(test: (candidate: string) => boolean, literal: number): PartMatcher {
  return Object.assign(test, { literal });
}

const GLOB_CHARS = /[*?[\]{}]/;

/** One path component as a matcher: literal, or a shell glob (`*`, `?`, `[...]`). */
function partMatcher(part: string): PartMatcher {
  if (!/[*?[\]]/.test(part)) return withLiteral((candidate) => candidate === part, part.length);
  let source = "";
  let literal = 0;
  for (let index = 0; index < part.length; index += 1) {
    const char = part[index] ?? "";
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[") {
      const close = part.indexOf("]", index + 2);
      if (close < 0) {
        source += "\\[";
        continue;
      }
      const body = part
        .slice(index + 1, close)
        .replace(/^[!^]/, "^")
        .replaceAll("\\", "\\\\");
      source += `[${body}]`;
      index = close;
    } else {
      source += char.replace(/[.+^${}()|\\/-]/g, "\\$&");
      literal += 1;
    }
  }
  let regex: RegExp;
  try {
    regex = new RegExp(`^${source}$`);
  } catch {
    // An unparseable pattern could match anything: treat it as matching.
    return withLiteral(() => true, 0);
  }
  // A shell glob does not match a leading dot unless the pattern has one.
  const dotSafe = !part.startsWith(".");
  return withLiteral(
    (candidate) => !(dotSafe && candidate.startsWith(".")) && regex.test(candidate),
    literal,
  );
}

/** `{a,b}` lists expanded (innermost first), at most MAX_EXPANSIONS results. */
function expandBraces(text: string): string[] | undefined {
  let results = [text];
  for (let round = 0; round < 8; round += 1) {
    const next: string[] = [];
    let changed = false;
    for (const item of results) {
      const match = /\{([^{}]*,[^{}]*)\}/.exec(item);
      if (match === null) {
        next.push(item);
        continue;
      }
      changed = true;
      for (const option of (match[1] ?? "").split(",")) {
        next.push(item.slice(0, match.index) + option + item.slice(match.index + match[0].length));
      }
    }
    if (next.length > MAX_EXPANSIONS) return undefined;
    results = next;
    if (!changed) return results;
  }
  return results;
}

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

/** Match normalized path components (literal or glob) against the protected set. */
function matchParts(
  parts: readonly PartMatcher[],
  scope: Scope,
  ancestors: boolean,
): string | undefined {
  for (const rule of ANYWHERE) {
    const n = rule.parts.length;
    for (let start = 0; start + n <= parts.length; start += 1) {
      const window = rule.parts.every((part, offset) => parts[start + offset]?.(part) === true);
      if (!window || !(rule.tree || start + n === parts.length)) continue;
      // Unanchored, so a glob must still spell most of the name: `*` or `*.json` alone is not
      // `managed-settings.json`, while `.cl?ude/settings.json` is `.claude/settings.json`.
      let literal = 0;
      for (let offset = 0; offset < n; offset += 1) literal += parts[start + offset]?.literal ?? 0;
      const length = rule.parts.reduce((sum, part) => sum + part.length, 0);
      if (literal * 2 >= length) return rule.target;
    }
  }
  for (const root of scope.roots) {
    const rootParts = root.path.split("/");
    const shared = Math.min(rootParts.length, parts.length);
    let prefix = true;
    for (let index = 0; index < shared && prefix; index += 1) {
      prefix = parts[index]?.(rootParts[index] ?? "") === true;
    }
    if (!prefix) continue;
    if (parts.length === rootParts.length) return root.target;
    if (parts.length > rootParts.length && root.tree) return root.target;
    if (ancestors && parts.length < rootParts.length) {
      // Above a protected root: protected only strictly below a floor (see Scope.floors).
      const depth = parts.length;
      const belowFloor = scope.floors.some((floor) => {
        const floorParts = floor.split("/");
        if (floorParts.length >= depth) return false;
        return floorParts.every((part, index) => parts[index]?.(part) === true);
      });
      if (belowFloor) return root.target;
    }
  }
  return undefined;
}

function matchPath(absolute: string, scope: Scope, ancestors: boolean): string | undefined {
  for (const form of pathForms(absolute)) {
    const parts = form.split("/").map(partMatcher);
    const target = matchParts(parts, scope, ancestors);
    if (target !== undefined) return target;
  }
  return undefined;
}

/** The path with symlinks resolved on its longest existing prefix. */
function resolveLinks(path: string, scope: Scope): string | undefined {
  let current = fsPath(path);
  const rest: string[] = [];
  for (;;) {
    const real = realpath(current, scope);
    if (real !== undefined) return join(real, ...[...rest].reverse());
    if (scope.exhausted) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    rest.push(basename(current));
    current = parent;
  }
}

function protectedPathTarget(raw: string, scope: Scope, ancestors: boolean): string | undefined {
  let text = raw.trim();
  if (text === "" || text.includes("\0")) return undefined;
  if (text.length > 4096) {
    scope.exhausted = true;
    return undefined;
  }
  // file:// URIs name a local path; other schemes are not files.
  const uri = /^file:\/\/(?:localhost)?(\/.*)$/i.exec(text);
  if (uri !== null) {
    try {
      text = decodeURIComponent(uri[1] ?? "").replace(/^\/([a-z]:)/i, "$1");
    } catch {
      text = uri[1] ?? "";
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return undefined;
  }
  if (GLOB_CHARS.test(text)) {
    const expanded = expandBraces(text);
    if (expanded === undefined) {
      scope.exhausted = true;
      return undefined;
    }
    for (const item of expanded) {
      const absolute = toAbsolute(item, scope.context);
      const target = GLOB_CHARS.test(item)
        ? matchPath(absolute, scope, ancestors)
        : (matchPath(absolute, scope, ancestors) ??
          (() => {
            const linked = resolveLinks(absolute, scope);
            return linked === undefined ? undefined : matchPath(linked, scope, ancestors);
          })());
      if (target !== undefined) return target;
    }
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
  new RegExp(`(?<![\\w$:{.\\[])${GUARDED_VARIABLE}\\s*\\+?=(?!=)`),
  new RegExp(`\\$\\{?env:${GUARDED_VARIABLE}\\}?\\s*\\+?=(?!=)`),
  new RegExp(`\\bunset\\b[^;|&\\n]*\\b${GUARDED_VARIABLE}`),
  new RegExp(`\\benv\\b[^;|&\\n]*?(?:\\s-u\\s*|\\s--unset[=\\s]+)${GUARDED_VARIABLE}`),
  new RegExp(`\\bexport\\s+-n\\s+${GUARDED_VARIABLE}`),
  new RegExp(`\\b(?:setx|setenv)\\s+(?:-\\w+\\s+)*${GUARDED_VARIABLE}`),
  // fish: set -gx / -Ux / -e NAME
  new RegExp(`\\bset\\s+(?:-{1,2}[a-z]+\\s+)+${GUARDED_VARIABLE}`),
  new RegExp(`setenvironmentvariable\\s*\\(\\s*${GUARDED_VARIABLE}`),
  new RegExp(
    `\\b(?:remove-item|ri|rm|del|erase|clear-item|clear-content|set-item|si|new-item|ni|rename-item|rni|move-item|mi)\\b[^;|&\\n]*\\benv:[\\\\/]?${GUARDED_VARIABLE}`,
  ),
  // The Windows registry copy of the user or machine environment.
  new RegExp(
    `\\breg(?:\\.exe)?\\s+(?:add|delete|import|copy)\\b[^;|&\\n]*environment[^;|&\\n]*${GUARDED_VARIABLE}`,
  ),
  new RegExp(
    `\\b(?:set-itemproperty|sp|new-itemproperty|remove-itemproperty|rp|rename-itemproperty)\\b[^;|&\\n]*environment[^;|&\\n]*${GUARDED_VARIABLE}`,
  ),
  // Python / Node from the command line.
  new RegExp(`environ\\s*\\[\\s*${GUARDED_VARIABLE}\\s*\\]\\s*=(?!=)`),
  new RegExp(
    `environ\\s*\\.\\s*(?:pop|setdefault|update|__setitem__|__delitem__)\\b[^;\\n]*${GUARDED_VARIABLE}`,
  ),
  new RegExp(`\\bdel\\s+os\\.environ\\s*\\[\\s*${GUARDED_VARIABLE}`),
  new RegExp(`\\b(?:putenv|unsetenv)\\s*\\(\\s*${GUARDED_VARIABLE}`),
  new RegExp(`process\\.env\\s*(?:\\.|\\[)\\s*${GUARDED_VARIABLE}\\s*\\]?\\s*=(?!=)`),
  new RegExp(`\\bdelete\\s+process\\.env\\s*(?:\\.|\\[)\\s*${GUARDED_VARIABLE}`),
  new RegExp(`\\benv\\s*[=:(]\\s*[{(\\[][\\s\\S]{0,4000}?${GUARDED_VARIABLE}\\s*[:,]`),
];

// A nested agent (claude, codex, cursor) started with a changed home, config search path, Node
// preload, PATH (a fake `node` for its hooks) or TLS trust, or told which settings to load: the
// nested host would load other settings, other hooks, or trust another judge. Matched only where
// the agent is the command that runs (so prose that mentions "claude code" is not a launch).
const AGENTS = new Set(["claude", "claude-code", "codex", "cursor", "cursor-agent"]);
const NESTED_VARIABLE =
  /^(?:\$\{?env:)?(?:home|userprofile|xdg_config_home|appdata|localappdata|node_options|path|node_tls_\w+|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir)\}?\s*\+?=/;
// Wrappers whose next word is the command that runs.
const LAUNCHERS = new Set([
  "sudo",
  "command",
  "exec",
  "nohup",
  "nice",
  "time",
  "env",
  "npx",
  "start",
  "&",
]);

function nestedAgentLaunch(segmentsText: string): string | undefined {
  let exported = false;
  for (const segment of segmentsText.split(/\|\||&&|[;|&\n()`]|\$\(/)) {
    const words = segment
      .trim()
      .split(/\s+/)
      .filter((word) => word !== "");
    let index = 0;
    while (index < words.length && KEYWORDS.has(words[index] ?? "")) index += 1;
    let prefixed = false;
    for (;;) {
      const word = words[index] ?? "";
      if (/^(?:export|set|setx|declare|typeset)$/.test(word)) {
        // `export NODE_OPTIONS=…` / `set -gx PATH …` changes what every later command inherits.
        if (
          words
            .slice(index + 1)
            .some((w) => NESTED_VARIABLE.test(w) || NESTED_VARIABLE.test(`${w}=`))
        ) {
          exported = true;
        }
        break;
      }
      if (NESTED_VARIABLE.test(word)) {
        prefixed = true;
        // A PowerShell `$env:X = …` statement on its own changes the rest of the command.
        if (word.startsWith("$")) exported = true;
        index += 1;
      } else if (/^[a-z_][a-z0-9_]*=/.test(word) || LAUNCHERS.has(word) || /^-/.test(word)) {
        index += 1;
      } else if (word === "timeout" || word === "-u") {
        index += 2;
      } else break;
    }
    // `claude`, a path to it, or a package runner's `@anthropic-ai/claude-code@1.2.3`.
    const command = basename((words[index] ?? "").replace(/\.(?:exe|cmd|ps1)$/, "")).replace(
      /@[^@/]*$/,
      "",
    );
    if (!AGENTS.has(command)) continue;
    const args = words.slice(index + 1);
    if (prefixed || exported) return "the environment of a nested agent";
    if (args.some((arg) => /^--setting(?:s|-sources)\b/.test(arg))) {
      return "the settings a nested agent loads";
    }
  }
  return undefined;
}

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

/**
 * Path pieces passed as separate string arguments (`path.join(home, '.claude', 'settings.json')`,
 * `Path.home() / ".config" / "atbash"`): each piece stands alone between quotes, commas, brackets or
 * spaces, so `.claude/agents` in a longer path does not count.
 */
function atom(value: string): RegExp {
  return new RegExp(
    `(?:^|[\\s,(\\[=:'"\`+/])${value.replace(/[.]/g, "\\.")}(?=$|[\\s,)\\]'"\`+;])`,
  );
}
const ATOM_PAIRS: readonly { first: RegExp; second: RegExp; target: string }[] = [
  {
    first: atom(".claude"),
    second: atom("(?:settings.json|settings.local.json|plugins)"),
    target: "Claude Code settings",
  },
  {
    first: atom(".codex"),
    second: atom("(?:hooks.json|config.toml|hooks|plugins)"),
    target: "Codex configuration",
  },
  { first: atom(".cursor"), second: atom("hooks.json"), target: "Cursor hooks" },
  { first: atom(".config"), second: atom("atbash"), target: "the Atbash key and configuration" },
  {
    first: atom("/?etc"),
    second: atom("hosts"),
    target: "the hosts file (judge address)",
  },
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

// `git grep` is not here: -O / --open-files-in-pager runs a command.
const READ_ONLY_GIT = new Set([
  "status",
  "log",
  "diff",
  "show",
  "ls-files",
  "blame",
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
      // Only `sed [-n] [-E|-r] 'RANGEp' file...`: printing a line range. Every other option (-i,
      // -e, -f, --in-place, ...) and every other script (w, e, W, s///w) is treated as a write.
      // The text is lower-cased, so `-E` reads as `-e` and is refused with it.
      return (
        args.every(
          (arg) =>
            !arg.startsWith("-") ||
            /^-[nrsuz]+$/.test(arg) ||
            /^--(quiet|silent|regexp-extended|null-data|separate|unbuffered|posix|debug)$/.test(
              arg,
            ),
        ) &&
        positional.length > 0 &&
        /^[\d,$]*p$/.test(positional[0] ?? "")
      );
    case "find":
      return !args.some((arg) =>
        /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg),
      );
    case "tree":
      return !args.some((arg) => /^-o|^--output/.test(arg));
    case "rg":
      return !args.some((arg) => /^--pre\b/.test(arg));
    case "env":
      // Bare `env` prints the environment; with arguments it runs a command.
      return args.length === 0;
    case "git": {
      // Anywhere on the line: an external diff or text conversion runs a program, --output writes.
      if (
        args.some((arg) => /^(--ext-diff|--textconv|--output|--open-files-in-pager|-o)/.test(arg))
      ) {
        return false;
      }
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index] ?? "";
        // -c name=value / --config-env inject configuration (a pager, an external diff, an alias to
        // a shell). The text is lower-cased, so -C <dir> is told apart by its value having no `=`.
        if (/^(--config-env|--exec-path)/.test(arg)) return false;
        if (/^-c./.test(arg) || (arg === "-c" && (args[index + 1] ?? "").includes("="))) {
          return false;
        }
        if (/^(-c|--git-dir|--work-tree|--namespace)$/.test(arg)) {
          index += 1;
          continue;
        }
        if (arg.startsWith("-")) continue;
        return READ_ONLY_GIT.has(arg);
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

/**
 * base64 / base64url tokens that decode to mostly printable text: each decoded payload on its own
 * (`echo … | base64 -d | sh`), plus the whole text with every such token decoded in place
 * (`cp x ~/$(echo LmNsYXVkZQ== | base64 -d)/settings.json`).
 */
function decodedPayloads(text: string): string[] {
  const out: string[] = [];
  let substituted = text;
  for (const token of text.match(/[A-Za-z0-9+/_-]{8,}={0,2}/g) ?? []) {
    const buffer = Buffer.from(token.replaceAll("-", "+").replaceAll("_", "/"), "base64");
    if (buffer.length < 4) continue;
    // PowerShell -EncodedCommand is UTF-16LE.
    const zeroes = buffer.filter((byte, i) => i % 2 === 1 && byte === 0).length;
    const decoded =
      zeroes * 2 >= buffer.length * 0.8 ? buffer.toString("utf16le") : buffer.toString("utf8");
    const printable = [...decoded].filter((c) => /[\x20-\x7e\t\r\n]/.test(c)).length;
    if (printable >= decoded.length * 0.9 && /[a-z]/i.test(decoded)) {
      out.push(decoded);
      substituted = substituted.replace(token, decoded);
    }
  }
  if (out.length > 0) out.push(substituted);
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
  /** Lower-cased, quotes kept: for separate string arguments. */
  quoted: string;
  /** Quotes and escapes removed, backslashes as slashes: for paths. */
  path: string;
  /** Quotes and escapes removed, backslashes dropped: for words (`cl\aude`). */
  word: string;
  /** Operators inside quotes blanked: for splitting into commands. */
  segments: string;
}

/**
 * The command in every form the checks read: as written, unescaped, reversed (for `| rev`), and
 * base64-decoded two levels deep. Undefined when there are more layers than the check reads.
 */
function commandForms(raw: string): CommandForm[] | undefined {
  const layers = [raw, unescape(raw)];
  if (/\brev\b/i.test(raw)) layers.push([...raw].reverse().join(""));
  for (let depth = 0, frontier = [...layers]; depth < 2; depth += 1) {
    const next = frontier.flatMap((layer) => decodedPayloads(layer));
    layers.push(...next, ...next.map(unescape));
    if (layers.length > MAX_LAYERS) return undefined;
    frontier = next;
  }
  const seen = new Set<string>();
  const forms: CommandForm[] = [];
  for (const layer of layers) {
    if (seen.has(layer)) continue;
    seen.add(layer);
    // Quotes, PowerShell's backtick and cmd's caret escape, and ANSI-C `$'` openers are removed so
    // `cl""aude`, `c\`laude` and `c^laude` read as `claude`.
    const unquoted = layer
      .toLowerCase()
      .replace(/\$'/g, "")
      .replace(/["'`^]/g, "");
    forms.push({
      quoted: layer.toLowerCase(),
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

function pathTokens(text: string, scope: Scope): string[] {
  const tokens: string[] = [];
  for (const token of text.split(/[\s;|&<>()]+/)) {
    if (token === "" || (token.startsWith("-") && !token.includes("="))) continue;
    const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
    if (value === "") continue;
    if (!/[/.~*?[{]/.test(value) && !/^\$|%/.test(value)) continue;
    if (tokens.length >= MAX_TOKENS) {
      scope.exhausted = true;
      break;
    }
    tokens.push(value);
  }
  return tokens;
}

function checkCommand(command: string, scope: Scope): SelfProtectionHit | undefined {
  if (command.length > MAX_TEXT) return OVER_LIMIT;
  const forms = commandForms(command);
  if (forms === undefined) return OVER_LIMIT;
  for (const form of forms) {
    for (const text of [form.path, form.word]) {
      for (const rule of SWITCH_RULES) {
        if (rule.pattern.test(text)) return { target: rule.target };
      }
      for (const rule of ENV_RULES) {
        if (rule.test(text)) return { target: "an Atbash or host configuration variable" };
      }
    }
    const nested = nestedAgentLaunch(form.segments);
    if (nested !== undefined) return { target: nested };
  }
  for (const form of forms) {
    // Only a command that could write needs to know whether it names a protected file.
    if (isReadOnlyCommand(form.segments)) continue;
    for (const rule of MENTION_RULES) {
      if (rule.pattern.test(form.path) || rule.pattern.test(form.word)) {
        return { target: rule.target };
      }
    }
    for (const pair of ATOM_PAIRS) {
      if (pair.first.test(form.quoted) && pair.second.test(form.quoted)) {
        return { target: pair.target };
      }
    }
    for (const token of pathTokens(form.path, scope)) {
      const target = protectedPathTarget(token, scope, true);
      if (target !== undefined) return { target };
      if (scope.exhausted) return OVER_LIMIT;
    }
    if (scope.exhausted) return OVER_LIMIT;
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
  "uri",
  "file_uri",
  "fileuri",
]);
const SHELL_TOOLS =
  /^(bash|powershell|pwsh|shell|sh|zsh|cmd|terminal|exec|exec_command|local_shell|run_shell_command|run_terminal_cmd|execute_command|run_command)$/;
const WRITE_TOOLS =
  /^(write|edit|multiedit|notebookedit|apply_patch|create|str_replace_editor|str_replace_based_edit_tool)$|write|edit|creat|delet|remov|move|renam|patch|replac|insert|updat|append|upload|save|mkdir|chmod|chown|symlink|link|copy|truncat|put|set/;

interface Collected {
  commands: string[];
  paths: string[];
  patches: string[];
  /** The input was larger or deeper than the check reads. */
  overflow: boolean;
}

function collect(value: unknown, key: string, out: Collected, depth: number): void {
  if (out.overflow) return;
  if (
    out.commands.length + out.paths.length + out.patches.length >= MAX_STRINGS ||
    depth > MAX_DEPTH
  ) {
    out.overflow = true;
    return;
  }
  if (typeof value === "string") {
    if (COMMAND_KEYS.has(key)) out.commands.push(value);
    if (PATH_KEYS.has(key)) out.paths.push(value);
    if (/^\*\*\* (?:begin patch|update file:|add file:|delete file:|move to:)/im.test(value)) {
      out.patches.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (COMMAND_KEYS.has(key) && value.every((item) => typeof item === "string")) {
      out.commands.push(value.join(" "));
    }
    for (const item of value) collect(item, key, out, depth + 1);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [childKey, child] of Object.entries(value)) {
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
  const out: Collected = { commands: [], paths: [], patches: [], overflow: false };
  if (typeof toolInput === "string" && SHELL_TOOLS.test(leaf)) {
    out.commands.push(toolInput);
  }
  collect(toolInput, "", out, 0);
  if (out.overflow) return OVER_LIMIT;
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
  return scope.exhausted ? OVER_LIMIT : undefined;
}

export function selfProtectionReason(hit: SelfProtectionHit): string {
  return (
    `Atbash BLOCK: this call would disable or change ${hit.target}. ` +
    "An agent may not switch off or re-point its own safety controls; make this change yourself, outside the agent."
  );
}
