import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

interface PluginManifest {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  hooks?: unknown;
  mcpServers?: unknown;
}

interface ClaudeMarketplaceManifest {
  name?: unknown;
  owner?: {
    name?: unknown;
  };
  plugins?: Array<{
    name?: unknown;
    source?: unknown;
    category?: unknown;
  }>;
}

interface HookManifest {
  hooks?: {
    PreToolUse?: Array<{
      matcher?: unknown;
      hooks?: Array<{
        type?: unknown;
        command?: unknown;
        timeout?: unknown;
      }>;
    }>;
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

test("Claude Code manifest matches the accepted plugin identity", async () => {
  const manifest = await readJson<PluginManifest>(
    join(process.cwd(), ".claude-plugin", "plugin.json"),
  );

  assert.equal(manifest.name, "atbash");
  assert.equal(typeof manifest.version, "string");
  assert.equal(typeof manifest.description, "string");
  assert.equal(manifest.hooks, undefined);
  assert.equal(manifest.mcpServers, undefined);
});

test("Claude Code marketplace points to the local Atbash plugin", async () => {
  const marketplace = await readJson<ClaudeMarketplaceManifest>(
    join(process.cwd(), "..", "..", ".claude-plugin", "marketplace.json"),
  );
  const entry = marketplace.plugins?.find((plugin) => plugin.name === "atbash");

  assert.equal(marketplace.name, "atbash-ai");
  assert.equal(marketplace.owner?.name, "Atbash AI");
  assert.ok(entry);
  assert.equal(entry.source, "./plugins/atbash");
  assert.equal(entry.category, "security");
});

test("hook bundle declares catch-all PreToolUse enforcement", async () => {
  const hookManifest = await readJson<HookManifest>(join(process.cwd(), "hooks", "hooks.json"));
  const matcher = hookManifest.hooks?.PreToolUse?.[0];
  const handler = matcher?.hooks?.[0];

  assert.equal(matcher?.matcher, "*");
  assert.equal(handler?.type, "command");
  assert.equal(handler?.command, 'node "${CLAUDE_PLUGIN_ROOT}/runtime/pre-tool-use.cjs"');
  assert.equal(handler?.timeout, 35);
});
