import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import { bundleAtbash, nativePackages, writeNativeLoader } from "./build-lib.mjs";

const require = createRequire(import.meta.url);
const sdkPackagePath = join(dirname(dirname(require.resolve("@atbash/sdk"))), "package.json");
const sdkPackage = JSON.parse(await readFile(sdkPackagePath, "utf8"));
const sdkVersion = sdkPackage.version;
if (typeof sdkVersion !== "string" || sdkVersion.length === 0) {
  throw new Error(`Could not resolve the installed Atbash SDK version from ${sdkPackagePath}.`);
}
const runtimeDir = "runtime";
// Everything is built here first and swapped into runtime/ only when the whole build succeeded, so
// a failed build never leaves the committed runtime half-deleted.
const stagingDir = `${runtimeDir}.build`;
const tempDir = await mkdtemp(join(tmpdir(), "atbash-marketplace-"));

function run(command, args) {
  // No shell: the arguments are file names and package specs, never interpreted.
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout || "unknown error"}`,
    );
  }
  return result.stdout;
}

// npm is run through node with npm's own entry script. spawnSync of "npm.cmd" without a shell is
// refused on current Node (EINVAL, CVE-2024-27980 hardening) and "npm" is not an executable on
// Windows, so the script location is resolved instead of the wrapper: the path npm itself
// exports when this build runs under `npm run`, otherwise the npm shipped next to the node binary.
function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(`Could not locate npm-cli.js (looked at: ${candidates.join(", ")}).`);
  }
  return resolve(found);
}

// On Windows the tar on PATH may be GNU tar from Git, which reads "C:\..." as a remote host; the
// bsdtar that ships with Windows is used by full path instead.
function resolveTar() {
  if (process.platform !== "win32") return "tar";
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return join(systemRoot, "System32", "tar.exe");
}

const npmCli = resolveNpmCli();
const tar = resolveTar();

try {
  await bundleAtbash(stagingDir, { minify: true, sourcemap: false });
  await writeNativeLoader(stagingDir);
  await mkdir(join(stagingDir, "licenses"), { recursive: true });
  await copyFile(
    join(dirname(sdkPackagePath), "LICENSE"),
    join(stagingDir, "licenses", "atbash-sdk.LICENSE"),
  );

  const platforms = {};
  for (const [platform, packageName] of Object.entries(nativePackages)) {
    const packOutput = run(process.execPath, [
      npmCli,
      "pack",
      `${packageName}@${sdkVersion}`,
      "--pack-destination",
      tempDir,
      "--json",
    ]);
    const [metadata] = JSON.parse(packOutput);
    const nativeFile = metadata?.files?.find((file) => file.path.endsWith(".node"));
    if (metadata?.filename === undefined || nativeFile?.path === undefined) {
      throw new Error(`${packageName}@${sdkVersion} did not contain a native .node file.`);
    }

    const archive = join(tempDir, metadata.filename);
    const extractDir = join(tempDir, platform);
    await mkdir(extractDir, { recursive: true });
    run(tar, ["-xzf", archive, "-C", extractDir]);

    const destinationDir = join(stagingDir, "native", platform);
    const destination = join(destinationDir, "atbash.node");
    await mkdir(destinationDir, { recursive: true });
    await copyFile(join(extractDir, "package", nativeFile.path), destination);

    const digest = createHash("sha256")
      .update(await readFile(destination))
      .digest("hex");
    platforms[platform] = {
      package: `${packageName}@${sdkVersion}`,
      sha256: digest,
    };
  }

  await writeFile(
    join(stagingDir, "manifest.json"),
    `${JSON.stringify({ sdkVersion, platforms }, null, 2)}\n`,
    "utf8",
  );

  await rm(runtimeDir, { force: true, recursive: true });
  await rename(stagingDir, runtimeDir);
  process.stdout.write(`Built universal Atbash marketplace runtime for SDK ${sdkVersion}.\n`);
} finally {
  await rm(stagingDir, { force: true, recursive: true });
  await rm(tempDir, { force: true, recursive: true });
}
