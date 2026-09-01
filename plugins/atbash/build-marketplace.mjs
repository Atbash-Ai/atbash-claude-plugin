import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import { bundleAtbash, nativePackages, writeNativeLoader } from "./build-lib.mjs";

const require = createRequire(import.meta.url);
const sdkPackagePath = join(dirname(dirname(require.resolve("@atbash/sdk"))), "package.json");
const sdkPackage = JSON.parse(await readFile(sdkPackagePath, "utf8"));
const sdkVersion = sdkPackage.version;
if (typeof sdkVersion !== "string" || sdkVersion.length === 0) {
  throw new Error(`Could not resolve the installed Atbash SDK version from ${sdkPackagePath}.`);
}
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const runtimeDir = "runtime";
const tempDir = await mkdtemp(join(tmpdir(), "atbash-marketplace-"));

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout || "unknown error"}`,
    );
  }
  return result.stdout;
}

try {
  await bundleAtbash(runtimeDir, { minify: true, sourcemap: false });
  await writeNativeLoader(runtimeDir);
  await mkdir(join(runtimeDir, "licenses"), { recursive: true });
  await copyFile(
    join(dirname(sdkPackagePath), "LICENSE"),
    join(runtimeDir, "licenses", "atbash-sdk.LICENSE"),
  );

  const platforms = {};
  for (const [platform, packageName] of Object.entries(nativePackages)) {
    const packOutput = run(npmExecutable, [
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
    run("tar", ["-xzf", archive, "-C", extractDir]);

    const destinationDir = join(runtimeDir, "native", platform);
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
    join(runtimeDir, "manifest.json"),
    `${JSON.stringify({ sdkVersion, platforms }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`Built universal Atbash marketplace runtime for SDK ${sdkVersion}.\n`);
} finally {
  await rm(tempDir, { force: true, recursive: true });
}
