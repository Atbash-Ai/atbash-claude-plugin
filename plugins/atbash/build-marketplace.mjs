import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { bundleAtbash, nativePackages, writeNativeLoader } from "./build-lib.mjs";

const runtimeDir = "runtime";
// Everything is built here first and swapped into runtime/ only when the whole build succeeded, so
// a failed build never leaves the committed runtime half-deleted.
const stagingDir = `${runtimeDir}.build`;
const previousDir = `${runtimeDir}.old`;

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
// Windows, so the script location is resolved instead of the wrapper: the npm shipped next to the
// node binary first, and only then the path npm itself exports when this build runs under
// `npm run` - an environment variable is the least trusted candidate, and it must name npm-cli.js.
export function resolveNpmCli(env = process.env, exists = existsSync) {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    env.npm_execpath,
  ].filter(
    (candidate) =>
      typeof candidate === "string" && candidate.length > 0 && basename(candidate) === "npm-cli.js",
  );
  const found = candidates.find((candidate) => exists(candidate));
  if (found === undefined) {
    throw new Error(`Could not locate npm-cli.js (looked at: ${candidates.join(", ")}).`);
  }
  return resolve(found);
}

// On Windows the tar on PATH may be GNU tar from Git, which reads "C:\..." as a remote host; the
// bsdtar that ships with Windows is used by full path instead.
export function resolveTar() {
  if (process.platform !== "win32") return "tar";
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return join(systemRoot, "System32", "tar.exe");
}

// The native file is copied by the path `npm pack --json` reports; a package that reports a path
// escaping its own extraction directory is refused, not followed.
export function containedNativePath(extractDir, reported) {
  const packageRoot = resolve(extractDir, "package");
  const target = resolve(packageRoot, reported);
  if (!target.startsWith(packageRoot + sep)) {
    throw new Error(
      `Refusing native file path ${JSON.stringify(reported)}: it leaves the package.`,
    );
  }
  return target;
}

export async function buildMarketplace() {
  const require = createRequire(import.meta.url);
  const sdkPackagePath = join(dirname(dirname(require.resolve("@atbash/sdk"))), "package.json");
  const sdkPackage = JSON.parse(await readFile(sdkPackagePath, "utf8"));
  const sdkVersion = sdkPackage.version;
  if (typeof sdkVersion !== "string" || sdkVersion.length === 0) {
    throw new Error(`Could not resolve the installed Atbash SDK version from ${sdkPackagePath}.`);
  }
  const npmCli = resolveNpmCli();
  const tar = resolveTar();
  const tempDir = await mkdtemp(join(tmpdir(), "atbash-marketplace-"));
  let swapped = false;

  try {
    await bundleAtbash(stagingDir, { minify: true, sourcemap: false });
    await writeNativeLoader(stagingDir);
    await mkdir(join(stagingDir, "licenses"), { recursive: true });
    await copyFile(
      join(dirname(sdkPackagePath), "LICENSE"),
      join(stagingDir, "licenses", "atbash-sdk.LICENSE"),
    );
    await chmod(join(stagingDir, "licenses", "atbash-sdk.LICENSE"), 0o644);

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
      const nativeSource = containedNativePath(extractDir, nativeFile.path);
      // A path check is not a file check: a symlink inside the package would be followed by copyFile.
      if (!lstatSync(nativeSource).isFile()) {
        throw new Error(
          `Refusing native file ${JSON.stringify(nativeFile.path)}: not a regular file.`,
        );
      }
      await copyFile(nativeSource, destination);
      // Modes are part of what CI diffs against the committed runtime; the tarball's mode is not ours.
      await chmod(destination, 0o644);

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
    await chmod(join(stagingDir, "manifest.json"), 0o644);

    // Swap: the committed runtime is moved aside, never deleted, until the new one is in place.
    await rm(previousDir, { force: true, recursive: true });
    if (existsSync(runtimeDir)) await rename(runtimeDir, previousDir);
    try {
      await rename(stagingDir, runtimeDir);
      swapped = true;
    } catch (error) {
      if (existsSync(previousDir)) await rename(previousDir, runtimeDir);
      throw error;
    }
    await rm(previousDir, { force: true, recursive: true });
    process.stdout.write(`Built universal Atbash marketplace runtime for SDK ${sdkVersion}.\n`);
  } finally {
    if (!swapped) await rm(stagingDir, { force: true, recursive: true });
    await rm(tempDir, { force: true, recursive: true });
  }
}

// Run the build only when this file is the script node was started with. Both sides are resolved
// through realpath so a drive-letter case or a symlinked checkout cannot turn the build into a
// silent no-op (which would leave CI's runtime diff comparing a stale tree and passing).
function isEntryPoint() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  await buildMarketplace();
}
