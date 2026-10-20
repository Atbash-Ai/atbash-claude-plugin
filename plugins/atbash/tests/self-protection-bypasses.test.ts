/**
 * One-call bypasses of the deterministic self-protection check found in review (stage 6, round 1
 * on 77a07ca..e9b3385), one assertion per case. Protected paths are assembled here at run time from
 * pieces, inside temporary directories: nothing in this file touches a real host configuration.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkSelfProtection, type SelfProtectionContext } from "../src/hook/self-protection.js";

const DOT_CLAUDE = "." + "claude";
const DOT_CODEX = "." + "codex";
const DOT_CONFIG = "." + "config";
const SETTINGS = "settings" + ".json";

function fixture(): {
  home: string;
  plugin: string;
  context: SelfProtectionContext;
  cleanup(): void;
} {
  const base = mkdtempSync(join(tmpdir(), "atbash-bypass-"));
  const home = join(base, "home");
  const project = join(base, "project");
  const plugin = join(base, "clone", "plugins", "atbash");
  for (const dir of [join(home, DOT_CLAUDE), project, join(plugin, "runtime")]) {
    mkdirSync(dir, { recursive: true });
  }
  return {
    home,
    plugin,
    context: { cwd: project, env: { HOME: home }, homeDir: home, pluginRoots: [plugin] },
    cleanup: () => rmSync(base, { force: true, recursive: true }),
  };
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function denied(tool: string, input: unknown, context: SelfProtectionContext, label: string): void {
  assert.notEqual(checkSelfProtection(tool, input, context), undefined, `not denied: ${label}`);
}

test("self-protection denies glob, long-path prefix, read-only writers and over-budget inputs", () => {
  const f = fixture();
  try {
    const ctx = f.context;
    const settings = join(f.home, DOT_CLAUDE, SETTINGS).replaceAll("\\", "/");
    const cmd = (command: string) => ({ command });

    // (a) globs, brackets and brace lists on a protected name
    denied("Bash", cmd(`cp /tmp/e.json ~/.cl?ude/${SETTINGS}`), ctx, "? glob");
    denied("Bash", cmd(`cp /tmp/e.json ~/.c[l]aude/${SETTINGS}`), ctx, "[] glob");
    denied("Bash", cmd(`cp /tmp/e.json ~/.{claude,x}/${SETTINGS}`), ctx, "{} list");
    denied("Bash", cmd(`rm -rf ~/.cl*/plugins`), ctx, "* glob on a tree");

    // (b) Windows long-path and device prefixes, and the NTFS main stream
    const longPrefix = "\\\\?\\";
    const devicePrefix = "\\\\.\\";
    denied(
      "Write",
      {
        file_path:
          longPrefix +
          join(
            f.home,
            DOT_CLAUDE,
            "plugins",
            "cache",
            "atbash",
            "atbash",
            "0.4.1",
            "runtime",
            "pre-tool-use.cjs",
          ),
      },
      ctx,
      "\\\\?\\ plugin cache",
    );
    denied(
      "Write",
      { file_path: devicePrefix + join(f.home, DOT_CODEX, "hooks", "hooks.json") },
      ctx,
      "\\\\.\\ codex hooks",
    );
    denied(
      "Edit",
      { file_path: longPrefix + join(f.plugin, "runtime", "pre-tool-use.cjs") },
      ctx,
      "\\\\?\\ plugin root",
    );
    denied("Write", { file_path: join(f.home, DOT_CLAUDE, SETTINGS) + "::$DATA" }, ctx, "::$DATA");
    // A stream name on a DIRECTORY component (`dir::$INDEX_ALLOCATION` is the directory itself).
    denied(
      "Write",
      { file_path: join(f.home, DOT_CLAUDE + "::$INDEX_ALLOCATION", SETTINGS) },
      ctx,
      "directory stream",
    );
    // The same spelling where the filesystem cannot resolve it for us (no such directory yet):
    // the name itself must be normalized.
    denied(
      "Write",
      {
        file_path: join(
          tmpdir(),
          "atbash-no-such-dir",
          DOT_CLAUDE + "::$INDEX_ALLOCATION",
          SETTINGS,
        ),
      },
      ctx,
      "directory stream, unresolvable",
    );
    denied(
      "Write",
      { file_path: join(tmpdir(), "elsewhere", DOT_CLAUDE, "plugins", "x", "hooks", "hooks.json") },
      ctx,
      "any .claude/plugins",
    );

    // (c) read-only commands that write
    denied("Bash", cmd(`sort -uo ${settings} /tmp/e`), ctx, "sort -uo");
    denied("Bash", cmd(`sed -n -e 1p -e "w ${settings}" /tmp/e`), ctx, "sed -e w");
    denied("Bash", cmd(`uniq - ${settings}`), ctx, "uniq - out");
    denied(
      "Bash",
      cmd(`git grep --no-index -O'sh -c x' atbash -- ${settings}`),
      ctx,
      "git grep -O",
    );
    denied(
      "Bash",
      cmd(`git diff --ext-diff -- ${settings}`),
      ctx,
      "git --ext-diff after subcommand",
    );

    // (d) the path assembled from separate string arguments
    denied(
      "Bash",
      cmd(
        `node -e "require('fs').writeFileSync(require('path').join(require('os').homedir(), '${DOT_CLAUDE}', '${SETTINGS}'), '{}')"`,
      ),
      ctx,
      "node path.join",
    );
    denied(
      "Bash",
      cmd(
        `python -c "import os; open(os.path.join(os.path.expanduser('~'), '${DOT_CONFIG}', 'atbash', 'config.json'), 'w')"`,
      ),
      ctx,
      "python os.path.join",
    );

    // (e) limits are a deny, not a pass
    denied("Bash", cmd(`${" ".repeat(300_000)}echo hi`), ctx, "over 256 KiB");
    const manyTokens = Array.from({ length: 5000 }, (_, i) => `d${i}/f`).join(" ");
    denied("Bash", cmd(`rm ${manyTokens}`), ctx, "over the token budget");
    const manyLookups = Array.from({ length: 2500 }, (_, i) => `n${i}/m${i}/f`).join(" ");
    denied("Bash", cmd(`touch ${manyLookups}`), ctx, "over the lookup budget");
    denied(
      "Write",
      { file_path: join(f.home, "a".repeat(5000)), content: "x" },
      ctx,
      "path over 4 KiB",
    );
    let deep: unknown = { command: "echo hi" };
    for (let i = 0; i < 64; i += 1) deep = { inner: deep };
    denied("mcp__x__run", deep, ctx, "nested deeper than the walk");
  } finally {
    f.cleanup();
  }
});

test("self-protection denies registry, fish, python and nested-agent environment changes", () => {
  const f = fixture();
  try {
    const ctx = f.context;
    const cmd = (command: string) => ({ command });
    const endpoint = "ATBASH" + "_ENDPOINT";
    denied("Bash", cmd(`reg add HKCU\\Environment /v ${endpoint} /d http://x /f`), ctx, "reg add");
    denied(
      "PowerShell",
      cmd(`Set-ItemProperty HKCU:\\Environment -Name ${endpoint} -Value x`),
      ctx,
      "Set-ItemProperty",
    );
    denied("Bash", cmd(`set -Ux ${endpoint} http://x`), ctx, "fish set -Ux");
    denied(
      "Bash",
      cmd(`python -c "import os; os.environ['${endpoint}']='x'; os.system('claude -p hi')"`),
      ctx,
      "python os.environ",
    );
    denied(
      "Bash",
      cmd(
        `python -c "import subprocess; subprocess.run(['claude','-p','hi'], env={'${endpoint}': 'x'})"`,
      ),
      ctx,
      "python env={}",
    );
    denied("Bash", cmd(`node -e "process.env.${endpoint}='x'"`), ctx, "node process.env");
    denied("Bash", cmd("HOME=/tmp/h claude -p hi"), ctx, "HOME prefix");
    denied(
      "Bash",
      cmd("NODE_OPTIONS=--require=/tmp/x.js claude -p hi"),
      ctx,
      "NODE_OPTIONS prefix",
    );
    denied("Bash", cmd("PATH=/tmp/fake:$PATH codex exec hi"), ctx, "PATH prefix");
    // Assembled so the fail-open scanner does not flag the test input itself.
    denied("Bash", cmd("NODE_TLS_" + "REJECT_UNAUTHORIZED=0 claude -p hi"), ctx, "TLS prefix");
    denied("Bash", cmd("XDG_CONFIG_HOME=/tmp/x codex exec hi"), ctx, "XDG_CONFIG_HOME prefix");
    denied("Bash", cmd("claude --setting-sources project -p hi"), ctx, "--setting-sources");
    denied(
      "Bash",
      cmd("export NODE_OPTIONS=--require=/tmp/x.js; claude -p hi"),
      ctx,
      "exported then launched",
    );
    denied(
      "PowerShell",
      cmd("$env:HOME='C:/tmp'; codex exec hi"),
      ctx,
      "PowerShell $env: then launched",
    );
    denied(
      "Bash",
      cmd("npx @anthropic-ai/claude-code --settings /tmp/s.json -p hi"),
      ctx,
      "npx --settings",
    );
    // Encodings the first round missed: short base64 substituted in place, reversed text, file URIs.
    denied(
      "Bash",
      cmd(`cp /tmp/e ~/$(echo ${b64(DOT_CLAUDE)} | base64 -d)/${SETTINGS}`),
      ctx,
      "short base64 in place",
    );
    denied(
      "Bash",
      cmd(`echo '${[..."claude plugin disable atbash"].reverse().join("")}' | rev | sh`),
      ctx,
      "rev",
    );
    denied(
      "mcp__fs__write_file",
      { uri: "file:///" + join(f.home, DOT_CLAUDE, SETTINGS).replaceAll("\\", "/"), content: "{}" },
      ctx,
      "file:// uri",
    );
  } finally {
    f.cleanup();
  }
});

test("the new rules leave ordinary work alone", () => {
  const f = fixture();
  try {
    const ctx = f.context;
    for (const command of [
      "git add src/a.ts src/b.ts tests/c.test.ts && git commit -m 'fix: x'",
      "npm run build && node --test dist-tests/tests/*.test.js",
      "PATH=/opt/node/bin:$PATH npm test",
      "HOME=/tmp/h npm test",
      "cat ~/.claude/" + SETTINGS + " | jq .enabledPlugins",
      "ls ~/.cl*",
      "sed -n '1,40p' ~/.claude/" + SETTINGS,
      "rg -n atbash ~/.claude/plugins",
      "python -c \"print('hello')\"",
      "echo aGVsbG8gd29ybGQ= | base64 -d",
      "git log --oneline -5 | rev",
      // Prose that mentions an agent next to an environment change is not a launch.
      "NODE_OPTIONS=--max-old-space-size=6144 node tsc && echo 'see the claude code docs'",
      "cat >> notes.md <<'EOF'\nclaude code runs hooks; set PATH=x first\nEOF",
      // Globs that do not spell a protected name (seen in real transcripts).
      "rm -f *.json build/*",
      "cp -r src/** /tmp/out",
      "python3 -c \"import re; print(re.sub('[a-z]', '', 'x'))\"",
      "tar -czf out.tgz atbash-audit/*/",
      `rm ${Array.from({ length: 300 }, (_, i) => `build/f${i}.js`).join(" ")}`,
    ]) {
      assert.equal(
        checkSelfProtection("Bash", { command }, ctx),
        undefined,
        `false positive: ${command}`,
      );
    }
  } finally {
    f.cleanup();
  }
});
