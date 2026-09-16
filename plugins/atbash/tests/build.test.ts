import assert from "node:assert/strict";
import { basename } from "node:path";
import test from "node:test";

interface BuildHelpers {
  resolveNpmCli: (
    env: Record<string, string | undefined>,
    exists: (p: string) => boolean,
  ) => string;
  containedNativePath: (extractDir: string, reported: string) => string;
}

// dist-tests/tests/ -> plugins/atbash/: the build script itself, not a copy.
const helpers = (await import(
  new URL("../../build-marketplace.mjs", import.meta.url).href
)) as BuildHelpers;

test("build: an npm_execpath that is not npm-cli.js is refused, and it is consulted last", () => {
  const seen: string[] = [];
  const exists = (p: string) => {
    seen.push(p);
    return false;
  };
  assert.throws(
    () => helpers.resolveNpmCli({ npm_execpath: "C:/evil/payload.js" }, exists),
    /Could not locate npm-cli\.js/,
  );
  assert.ok(
    seen.every((p) => basename(p) === "npm-cli.js"),
    `a candidate that is not npm-cli.js was consulted: ${seen.join(", ")}`,
  );
  assert.ok(!seen.some((p) => p.includes("payload")), "the foreign script must never be probed");

  const legit = "/opt/tools/npm/bin/npm-cli.js";
  const order: string[] = [];
  const found = helpers.resolveNpmCli({ npm_execpath: legit }, (p) => {
    order.push(p);
    return p === legit;
  });
  assert.equal(basename(found), "npm-cli.js");
  assert.equal(order[order.length - 1], legit, "npm_execpath must be the last candidate");
});

test("build: a native file path that escapes the extraction directory is refused", () => {
  const extractDir = process.platform === "win32" ? "C:/tmp/extract" : "/tmp/extract";
  assert.throws(
    () => helpers.containedNativePath(extractDir, "../../secret.node"),
    /leaves the package/,
  );
  assert.throws(
    () => helpers.containedNativePath(extractDir, "/etc/passwd.node"),
    /leaves the package/,
  );
  assert.throws(() => helpers.containedNativePath(extractDir, ""), /leaves the package/);
  const ok = helpers.containedNativePath(extractDir, "atbash.win32-x64-msvc.node");
  assert.ok(ok.endsWith("atbash.win32-x64-msvc.node"));
  assert.ok(ok.includes("package"));
});
