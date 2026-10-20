/**
 * The deterministic self-protection check, call by call: what it must deny (with the usual
 * obfuscations) and - just as important for a check that runs on every tool call - what it must
 * leave to the judge. The hook-level proof is self-protection-host.test.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkSelfProtection,
  resolvePluginRoots,
  type SelfProtectionContext,
} from "../src/hook/self-protection.js";
import { evaluatePreToolUse } from "../src/hook/runner.js";
import { makeHookInput } from "./fixtures.js";

interface Fixture {
  home: string;
  project: string;
  plugin: string;
  context: SelfProtectionContext;
  cleanup(): void;
}

function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "atbash-selfprotect-"));
  const home = join(base, "home");
  const project = join(base, "project");
  const plugin = join(home, "dev", "atbash-plugin", "plugins", "atbash");
  for (const dir of [join(home, ".claude"), join(home, ".config", "atbash"), project, plugin]) {
    mkdirSync(dir, { recursive: true });
  }
  return {
    home,
    project,
    plugin,
    context: { cwd: project, env: { HOME: home }, homeDir: home, pluginRoots: [plugin] },
    cleanup: () => rmSync(base, { force: true, recursive: true }),
  };
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function bash(command: string) {
  return { tool: "Bash", input: { command } };
}

test("plugin and hook switches are denied, however they are spelled", () => {
  const f = fixture();
  try {
    const commands = [
      "claude plugin disable atbash",
      "claude plugin disable atbash@atbash-ai",
      "claude plugins uninstall atbash@atbash-ai --scope user",
      "claude plugin remove atbash",
      "claude plugin marketplace remove atbash-ai",
      "claude plugin disable --all",
      "CLAUDE PLUGIN DISABLE ATBASH",
      "npx @anthropic-ai/claude-code plugin disable atbash",
      `bash -c "claude plugin disable atbash"`,
      `sh -c 'cl""aude plu''gin dis\\able atb\\ash'`,
      `eval "$(echo claude plugin disable atbash)"`,
      `echo ${b64("claude plugin disable atbash")} | base64 -d | sh`,
      `echo ${b64(`bash -c "${b64("claude plugin uninstall atbash")}"`)} | base64 --decode | bash`,
      `powershell -EncodedCommand ${Buffer.from("claude plugin disable atbash", "utf16le").toString("base64")}`,
      "$'\\x63laude' plugin disable atbash",
      "c`l`a`u`d`e plugin disable atbash",
      "c^laude plugin disable atbash",
      "x=claude; $x plugin disable atbash",
      "codex plugin remove atbash",
      "node plugins/atbash/runtime/install-hook.cjs --uninstall",
      "codex features disable codex_hooks",
      "codex -c features.codex_hooks=false",
      `claude --settings '{"disableAllHooks": true}' -p hi`,
      "claude config set -g env.FOO 1",
    ];
    for (const command of commands) {
      assert.notEqual(
        checkSelfProtection("Bash", { command }, f.context),
        undefined,
        `not denied: ${command}`,
      );
    }
  } finally {
    f.cleanup();
  }
});

test("changes to Atbash and host configuration variables are denied; reading them is not", () => {
  const f = fixture();
  try {
    const denied = [
      "unset ATBASH_AGENT_KEY",
      "unset -v FOO ATBASH_ENDPOINT",
      // Only visible once the ANSI-C escape is expanded: unset.
      "$'\\x75nset' ATBASH_AGENT_KEY",
      "env -u ATBASH_AGENT_KEY claude -p hi",
      "env --unset=ATBASH_ENDPOINT claude",
      "export ATBASH_ENDPOINT=http://127.0.0.1:9",
      "ATBASH_ENDPOINT=http://127.0.0.1:9 claude -p hi",
      "ATBASH_DEV_ALLOW_LOCAL_JUDGE=1 codex exec x",
      "export -n ATBASH_ORG_NAME",
      "setx ATBASH_ENDPOINT http://evil",
      "$env:ATBASH_ENDPOINT = 'http://127.0.0.1:9'",
      "${env:ATBASH_AGENT_KEY}='x'",
      "Remove-Item Env:ATBASH_AGENT_KEY",
      "[Environment]::SetEnvironmentVariable('ATBASH_ENDPOINT','x','User')",
      "launchctl setenv ATBASH_ENDPOINT http://evil",
      "CLAUDE_CONFIG_DIR=/tmp/clean claude -p hi",
      "CODEX_HOME=/tmp/clean codex exec hi",
      `bash -c "export ATBASH_ENDPOINT=x"`,
      `echo ${b64("unset ATBASH_AGENT_KEY")} | base64 -d | bash`,
    ];
    for (const command of denied) {
      assert.notEqual(
        checkSelfProtection("Bash", { command }, f.context),
        undefined,
        `not denied: ${command}`,
      );
    }
    const allowed = [
      "echo $ATBASH_ORG_NAME",
      'test -n "$ATBASH_AGENT_KEY" && echo set',
      'if [ "$ATBASH_ENDPOINT" == "" ]; then echo default; fi',
      "grep -rn ATBASH_ENDPOINT src",
      "printenv | grep ATBASH_",
      "$env:ATBASH_ORG_NAME",
    ];
    for (const command of allowed) {
      assert.equal(
        checkSelfProtection("Bash", { command }, f.context),
        undefined,
        `false positive: ${command}`,
      );
    }
  } finally {
    f.cleanup();
  }
});

test("writes to protected files are denied through every spelling; reads are left to the judge", () => {
  const f = fixture();
  try {
    const settings = join(f.home, ".claude", "settings.json");
    const denied: { tool: string; input: unknown }[] = [
      bash("echo '{}' > ~/.claude/settings.json"),
      // Only visible once the ANSI-C escape is expanded: ~/.claude/settings.json.
      bash("echo {} > ~/$'\\x2e'claude/settings.json"),
      bash("echo x >> $HOME/.claude/settings.local.json"),
      bash("tee ~/.claude/settings.json < /tmp/x"),
      bash("sed -i 's/atbash/none/' ~/.claude/settings.json"),
      bash(
        "jq '.enabledPlugins={}' ~/.claude/settings.json > /tmp/s && mv /tmp/s ~/.claude/settings.json",
      ),
      bash("rm -rf ~/.claude/plugins/cache/atbash"),
      bash("rm -rf ~/.claude"),
      bash("rm -rf ~/.config"),
      bash("mv ~/.config/atbash ~/.config/atbash.bak"),
      bash("cd ~/.config/atbash && rm config.json"),
      bash("cd ~/.claude && echo '{}' > settings.json"),
      bash("cd ~/.claude; rm -rf plugins"),
      // Read-only commands with the options or prefixes that make them write or execute.
      bash("git -c core.pager='rm ~/.claude/settings.json' log -- ~/.claude/settings.json"),
      bash(`rg --pre 'sh -c "rm x"' atbash ~/.claude/settings.json`),
      bash("LESSOPEN='|rm x' less ~/.claude/settings.json"),
      bash("git diff --output=~/.claude/settings.json HEAD"),
      bash("sed -n '1w ~/.claude/settings.json' /tmp/evil"),
      bash("find ~/.claude/plugins -name '*.json' -delete"),
      bash("sort -o ~/.claude/settings.json /tmp/evil"),
      bash("Get-Item ~/.claude/settings.json | Get-Content -Path { Remove-Item $_; 'x' }"),
      bash("./cat ~/.claude/settings.json"),
      bash("env ATBASH_X=1 rm ~/.claude/settings.json"),
      bash("Get-Content ~/.claude/settings.json | Where-Object { Remove-Item $_ }"),
      bash("Get-Item ~/.claude/settings.json | Select-Object @{n='x';e={Remove-Item $_}}"),
      bash('echo "$(rm ~/.claude/settings.json)"'),
      bash("cat ~/.claude/settings.json `rm ~/.claude/settings.json`"),
      bash("cat ~/.claude/settings.json & rm ~/.claude/settings.json"),
      bash("cat <(rm ~/.claude/settings.json)"),
      bash("(cd ~/.config) && rm -r atbash"),
      bash("cd ~/.codex\necho {} > hooks.json"),
      bash(`python -c "open('${settings.replaceAll("\\", "/")}','w').write('{}')"`),
      bash(`node -e "require('fs').writeFileSync('${settings.replaceAll("\\", "\\\\")}', '{}')"`),
      bash("cp /tmp/evil.json .claude/settings.local.json"),
      bash("ln -sf /tmp/evil.json ~/.claude/settings.json"),
      bash("chmod 000 ~/.config/atbash/guard-client-key"),
      bash("echo 127.0.0.1 atbash.ai >> /etc/hosts"),
      bash("Add-Content C:\\Windows\\System32\\drivers\\etc\\hosts '127.0.0.1 atbash.ai'"),
      bash("Set-Content -Path $env:USERPROFILE\\.claude\\settings.json -Value '{}'"),
      bash("echo x > ~/.codex/hooks.json"),
      bash("sed -i s/atbash// ~/.codex/config.toml"),
      bash("echo {} > .codex/hooks.json"),
      bash("echo {} > .cursor/hooks.json"),
      bash(`echo x > ${join(f.plugin, "runtime", "pre-tool-use.cjs").replaceAll("\\", "/")}`),
      bash(`echo ${b64("rm ~/.claude/settings.json")} | base64 -d | sh`),
      bash("sudo tee /etc/claude-code/managed-settings.json"),
      { tool: "Write", input: { file_path: settings, content: "{}" } },
      { tool: "Write", input: { file_path: "~/.claude/settings.json", content: "{}" } },
      {
        tool: "Edit",
        input: { file_path: settings.toUpperCase(), old_string: "a", new_string: "b" },
      },
      {
        tool: "MultiEdit",
        input: { file_path: join(f.project, ".claude", "settings.json"), edits: [] },
      },
      { tool: "Write", input: { file_path: ".claude/settings.local.json", content: "{}" } },
      {
        tool: "Write",
        input: { file_path: join(f.home, ".config", "atbash", "config.json"), content: "{}" },
      },
      { tool: "Write", input: { file_path: join(f.plugin, "hooks", "hooks.json"), content: "{}" } },
      { tool: "Edit", input: { file_path: join(f.plugin, ".claude-plugin", "plugin.json") } },
      {
        tool: "NotebookEdit",
        input: { notebook_path: join(f.home, ".claude", "plugins", "x.ipynb") },
      },
      { tool: "mcp__filesystem__write_file", input: { path: settings, content: "{}" } },
      {
        tool: "mcp__filesystem__move_file",
        input: { source: join(f.home, ".claude"), destination: "/tmp/x" },
      },
      {
        tool: "apply_patch",
        input: {
          command: `*** Begin Patch\n*** Update File: ${settings}\n@@\n-a\n+b\n*** End Patch`,
        },
      },
      {
        tool: "apply_patch",
        input: { patch: "*** Begin Patch\n*** Add File: .codex/hooks.json\n+{}\n*** End Patch" },
      },
    ];
    for (const { tool, input } of denied) {
      assert.notEqual(
        checkSelfProtection(tool, input, f.context),
        undefined,
        `not denied: ${tool} ${JSON.stringify(input)}`,
      );
    }
    const allowed: { tool: string; input: unknown }[] = [
      bash("cat ~/.claude/settings.json"),
      bash("jq .enabledPlugins ~/.claude/settings.json"),
      bash("grep -n atbash ~/.claude/settings.json | head -5"),
      bash("sed -n '1,20p' ~/.config/atbash/config.json"),
      bash("ls -la ~/.claude/plugins"),
      bash("find ~/.claude/plugins -name hooks.json"),
      bash("Get-Content $env:USERPROFILE\\.claude\\settings.json"),
      bash("diff ~/.claude/settings.json /tmp/backup.json 2>/dev/null"),
      bash("git status --short"),
      bash("git log --oneline -5 -- .claude/settings.json"),
      bash("npm test"),
      bash("rm -rf node_modules dist"),
      bash("echo hello > notes.txt"),
      bash("claude plugin list"),
      bash("claude plugin install other@market"),
      bash("claude plugin disable some-other-plugin"),
      bash("cat /etc/hosts"),
      bash("ls ~"),
      bash("mkdir -p ~/.claude-projects/tmp && echo x > ~/.claude-projects/tmp/a"),
      // A repository with a .claude directory and a plugins/ workspace, or a ~/.config file next
      // to an @atbash package name: no protected file is named.
      bash("cat .claude/agents/reviewer.md && npm run build --workspace plugins/atbash"),
      bash("cat ~/.config/git/config && npm install @atbash/sdk@0.9.1"),
      bash("ls .codex/ && npm test -- tests/hooks.json.test.ts"),
      // Operators inside quotes are not commands; a home directory or / alone is not a target.
      bash('grep -E "atbash|plugin" ~/.claude/settings.json 2>&1 | cut -c1-80'),
      bash('cat "/tmp/New folder (3)/notes.txt" ~/.claude/settings.json'),
      bash("cd ~ && npm test"),
      bash("cd / && ls; echo $((1 / 2))"),
      bash("for f in ~/.claude/plugins/*; do cat $f; done"),
      bash("sed -n '1,20p' ~/.claude/settings.json | tr -d '\\r'"),
      bash("git -C ~/.claude log --oneline -3 -- settings.json"),
      bash("DEBUG=1 npm test"),
      bash(
        'Get-ChildItem "$env:USERPROFILE\\.claude" -Filter "settings*.json" | Select-Object Name, Length',
      ),
      bash("env | grep -i atbash; ls -la ~/.config/atbash 2>/dev/null"),
      bash("export ATBASH_LOCAL_NODE_URL=http://127.0.0.1:7760 && node scripts/seed.mjs"),
      { tool: "Read", input: { file_path: settings } },
      { tool: "Grep", input: { pattern: "atbash", path: join(f.home, ".claude") } },
      { tool: "Glob", input: { pattern: "**/settings.json", path: f.home } },
      {
        tool: "Write",
        input: { file_path: join(f.project, "src", "settings.json"), content: "{}" },
      },
      { tool: "Write", input: { file_path: join(f.project, "docs", "claude-settings.json.md") } },
      { tool: "Edit", input: { file_path: join(f.plugin, "src", "hook", "runner.ts") } },
      { tool: "Write", input: { file_path: join(f.home, ".claude", "CLAUDE.md"), content: "x" } },
      { tool: "mcp__filesystem__read_file", input: { path: settings } },
      { tool: "WebFetch", input: { url: "https://example.com/.claude/settings.json" } },
    ];
    for (const { tool, input } of allowed) {
      assert.equal(
        checkSelfProtection(tool, input, f.context),
        undefined,
        `false positive: ${tool} ${JSON.stringify(input)}`,
      );
    }
  } finally {
    f.cleanup();
  }
});

test("a symlinked path to a protected directory is resolved before the check", () => {
  const f = fixture();
  try {
    const link = join(f.project, "innocent");
    symlinkSync(join(f.home, ".config", "atbash"), link, "junction");
    assert.notEqual(
      checkSelfProtection("Write", { file_path: join(link, "config.json") }, f.context),
      undefined,
    );
    assert.notEqual(
      checkSelfProtection("Bash", { command: "echo {} > innocent/config.json" }, f.context),
      undefined,
    );
    assert.equal(
      checkSelfProtection("Bash", { command: "cat innocent/config.json" }, f.context),
      undefined,
    );
  } finally {
    f.cleanup();
  }
});

test("CODEX_HOME and CLAUDE_CONFIG_DIR move the protected host files with them", () => {
  const f = fixture();
  try {
    const context = {
      ...f.context,
      env: {
        HOME: f.home,
        CODEX_HOME: join(f.project, "codex-home"),
        CLAUDE_CONFIG_DIR: join(f.project, "cc"),
      },
    };
    for (const path of [
      join(f.project, "codex-home", "config.toml"),
      join(f.project, "codex-home", "hooks", "x.json"),
      join(f.project, "cc", "settings.json"),
      join(f.project, "cc", "plugins", "cache", "atbash", "hooks", "hooks.json"),
    ]) {
      assert.notEqual(checkSelfProtection("Write", { file_path: path }, context), undefined, path);
    }
  } finally {
    f.cleanup();
  }
});

test("the plugin root comes from the host variable and from the entry script's location", () => {
  const roots = resolvePluginRoots(
    { CLAUDE_PLUGIN_ROOT: join(tmpdir(), "cc-root"), PLUGIN_ROOT: "relative/ignored" },
    join(tmpdir(), "install", "plugins", "atbash", "runtime", "pre-tool-use.cjs"),
  );
  assert.deepEqual(roots, [
    join(tmpdir(), "cc-root"),
    join(tmpdir(), "install", "plugins", "atbash"),
  ]);
  assert.deepEqual(resolvePluginRoots({}, join(tmpdir(), "elsewhere", "hook.cjs")), []);
});

test("the runner denies a self-protection hit without consulting the judge", async () => {
  let consulted = 0;
  const outcome = await evaluatePreToolUse(
    makeHookInput({ tool_name: "Bash", tool_input: { command: "claude plugin disable atbash" } }),
    () => ({
      async auditToolCall() {
        consulted += 1;
        return { allow: true, verdict: "ALLOW" };
      },
    }),
  );
  assert.equal(consulted, 0);
  assert.equal(outcome.allow, false);
  assert.match(
    outcome.allow ? "" : outcome.reason,
    /^Atbash BLOCK: this call would disable or change the Atbash plugin/,
  );
});

test("oversized and deeply nested inputs are denied, never passed unread", () => {
  const f = fixture();
  try {
    let nested: unknown = { command: "echo hello" };
    for (let i = 0; i < 50; i += 1) nested = { inner: nested };
    // Deeper than the walk goes: a limit is a deny, not a way around the check.
    assert.match(
      checkSelfProtection("mcp__x__run", nested, f.context)?.target ?? "",
      /too large or too deep/,
    );
    const huge = `${"a ".repeat(200_000)}; echo hello`;
    assert.match(
      checkSelfProtection("Bash", { command: huge }, f.context)?.target ?? "",
      /too large or too deep/,
    );
    // Within the limits, an ordinary deep input is not a hit.
    let shallow: unknown = { command: "echo hello" };
    for (let i = 0; i < 10; i += 1) shallow = { inner: shallow };
    assert.equal(checkSelfProtection("mcp__x__run", shallow, f.context), undefined);
    assert.notEqual(
      checkSelfProtection(
        "Bash",
        { command: ["bash", "-lc", "claude plugin disable atbash"] },
        f.context,
      ),
      undefined,
    );
  } finally {
    f.cleanup();
  }
});
