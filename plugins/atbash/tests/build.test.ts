import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface BuildHelpers {
  resolveNpmCli: (
    env: Record<string, string | undefined>,
    exists: (p: string) => boolean,
  ) => string;
  containedNativePath: (extractDir: string, reported: string) => string;
  assertRegularFile: (path: string, lstat?: (p: string) => { isFile(): boolean }) => string;
  isEntryPoint: (argv1: string | undefined, moduleUrl?: string) => boolean;
}

// dist-tests/tests/ -> plugins/atbash/: the build script itself, not a copy.
const buildScriptUrl = new URL("../../build-marketplace.mjs", import.meta.url);
const buildScriptPath = fileURLToPath(buildScriptUrl);
const helpers = (await import(buildScriptUrl.href)) as BuildHelpers;

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

test("build: a native file that is not a regular file is refused (a path check is not a file check)", () => {
  // A directory reached through a junction: contained by path, but not a file - and neither is a
  // symlink, which copyFile would otherwise follow out of the package.
  const dir = mkdtempSync(join(tmpdir(), "atbash-build-link-"));
  try {
    const link = join(dir, "atbash.node");
    symlinkSync(dir, link, "junction");
    assert.throws(() => helpers.assertRegularFile(link), /not a regular file/);
    assert.throws(() => helpers.assertRegularFile(dir), /not a regular file/);
    assert.throws(
      () => helpers.assertRegularFile("anything.node", () => ({ isFile: () => false })),
      /not a regular file/,
    );
    assert.equal(helpers.assertRegularFile(buildScriptPath), buildScriptPath);
    unlinkSync(link);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("build: the entry-point guard matches the script through a junction and never a different file", () => {
  // The build must run when node was started with this file, whatever path spelling reached it
  // (a junctioned checkout is how this workspace is reached), and must never run from an import.
  assert.equal(helpers.isEntryPoint(buildScriptPath), true);
  assert.equal(helpers.isEntryPoint(fileURLToPath(import.meta.url)), false, "another file");
  assert.equal(helpers.isEntryPoint(undefined), false, "no argv[1]");
  assert.equal(helpers.isEntryPoint(join(tmpdir(), "does-not-exist.mjs")), false, "missing file");
  const dir = mkdtempSync(join(tmpdir(), "atbash-build-junction-"));
  try {
    const link = join(dir, "plugin");
    symlinkSync(resolve(buildScriptPath, ".."), link, "junction");
    assert.equal(helpers.isEntryPoint(join(link, "build-marketplace.mjs")), true, "junction path");
    // The junction points at the live source tree: unlink it before the recursive removal.
    unlinkSync(link);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
