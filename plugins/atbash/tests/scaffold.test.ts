import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

interface PluginManifest {
  name?: unknown;
  skills?: unknown;
  hooks?: unknown;
  mcpServers?: unknown;
  interface?: {
    displayName?: unknown;
  };
}

interface MarketplaceManifest {
  plugins?: Array<{
    name?: unknown;
    source?: {
      path?: unknown;
    };
    policy?: {
      installation?: unknown;
      authentication?: unknown;
    };
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

test("Codex manifest matches the accepted plugin identity", async () => {
  const manifest = await readJson<PluginManifest>(
    join(process.cwd(), ".codex-plugin", "plugin.json"),
  );

  assert.equal(manifest.name, "atbash");
  assert.equal(manifest.interface?.displayName, "Atbash Safety");
  assert.equal(manifest.skills, undefined);
  assert.equal(manifest.mcpServers, undefined);
});

test("repo marketplace points to the local Atbash plugin", async () => {
  const marketplace = await readJson<MarketplaceManifest>(
    join(process.cwd(), "..", "..", ".agents", "plugins", "marketplace.json"),
  );
  const entry = marketplace.plugins?.find((plugin) => plugin.name === "atbash");

  assert.ok(entry);
  assert.equal(entry.source?.path, "./plugins/atbash");
  assert.equal(entry.policy?.installation, "AVAILABLE");
  assert.equal(entry.policy?.authentication, "ON_INSTALL");
});

test("hook bundle declares catch-all PreToolUse enforcement", async () => {
  const hookManifest = await readJson<HookManifest>(join(process.cwd(), "hooks", "hooks.json"));
  const matcher = hookManifest.hooks?.PreToolUse?.[0];
  const handler = matcher?.hooks?.[0];

  assert.equal(matcher?.matcher, "*");
  assert.equal(handler?.type, "command");
  assert.equal(handler?.command, 'node "$PLUGIN_ROOT/dist/pre-tool-use.cjs"');
  assert.equal(handler?.timeout, 35);
});
