import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { chmod, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { URL } from "node:url";

export const nativePackages = {
  "darwin-arm64": "@atbash/sdk-darwin-arm64",
  "linux-arm64": "@atbash/sdk-linux-arm64-gnu",
  "linux-x64": "@atbash/sdk-linux-x64-gnu",
  "win32-x64": "@atbash/sdk-win32-x64-msvc",
};

const sdkNativeMarker = 'require2("../index.js")';
const require = createRequire(import.meta.url);
const environments = JSON.parse(
  readFileSync(new URL("./build-environments.json", import.meta.url), "utf8"),
);

/**
 * The build environment comes from `--env <name>` or ATBASH_BUILD_ENV and
 * defaults to prod. An unknown name stops the build rather than guessing.
 */
export function selectBuildEnvironment(argv = process.argv.slice(2), env = process.env) {
  const flag = argv.findIndex((arg) => arg === "--env" || arg.startsWith("--env="));
  const fromFlag =
    flag === -1 ? undefined : argv[flag].includes("=") ? argv[flag].split("=")[1] : argv[flag + 1];
  const name = (fromFlag ?? env.ATBASH_BUILD_ENV ?? "").trim() || "prod";
  const environment = environments[name];
  if (environment === undefined) {
    throw new Error(
      `Unknown Atbash build environment "${name}". Use one of: ${Object.keys(environments).join(", ")}.`,
    );
  }
  return { name, ...environment };
}

/** The installed SDK package for an environment, with a resolver rooted at that package. */
export function resolveEnvironmentSdk(environment) {
  const packageJsonPath = join(
    dirname(dirname(require.resolve(environment.sdkPackage))),
    "package.json",
  );
  const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`Could not resolve the installed Atbash SDK version from ${packageJsonPath}.`);
  }
  return { packageJsonPath, version, require: createRequire(packageJsonPath) };
}

export async function bundleAtbash(outdir, { minify = false, sourcemap = true, environment }) {
  await rm(outdir, { force: true, recursive: true });

  await build({
    ...(environment.sdkPackage === "@atbash/sdk"
      ? {}
      : { alias: { "@atbash/sdk": environment.sdkPackage } }),
    bundle: true,
    entryPoints: {
      index: "src/index.ts",
      // The host runs pre-tool-use.cjs, which is the un-bundled shim (src/hook/shim.cjs, copied
      // below); the bundled hook it loads is pre-tool-use-main.cjs.
      "pre-tool-use-main": "src/pre-tool-use.ts",
      status: "src/status.ts",
      control: "src/control.ts",
    },
    format: "cjs",
    legalComments: "none",
    minify,
    outdir,
    outExtension: { ".js": ".cjs" },
    platform: "node",
    plugins: [
      {
        name: "atbash-native-loader",
        setup(esbuild) {
          esbuild.onLoad(
            { filter: /@atbash[\\/]sdk(?:-dev)?[\\/]dist[\\/]index\.mjs$/ },
            async ({ path }) => {
              const { readFile } = await import("node:fs/promises");
              const source = await readFile(path, "utf8");
              if (!source.includes(sdkNativeMarker)) {
                throw new Error("The installed Atbash SDK has an unexpected native-loader layout.");
              }

              return {
                contents: source.replace(sdkNativeMarker, 'require2("./atbash-native.cjs")'),
                loader: "js",
              };
            },
          );
        },
      },
    ],
    sourcemap,
    sourcesContent: false,
    target: "node22",
  });

  for (const entry of ["index", "pre-tool-use-main", "status", "control"]) {
    const outputPath = join(outdir, `${entry}.cjs`);
    const source = await readFile(outputPath, "utf8");
    await writeFile(outputPath, source.replaceAll("\t", "  "), "utf8");
  }

  // The shim is shipped verbatim, never bundled or minified: it has to load when the bundle cannot.
  await copyFile("src/hook/shim.cjs", join(outdir, "pre-tool-use.cjs"));

  // File modes are part of what CI diffs against the committed runtime; set them explicitly so a
  // build reproduces byte-for-byte and mode-for-mode on every platform and umask: the hashbang
  // bundles are executable (as esbuild marks them), the shim and the library are not.
  for (const [entry, mode] of [
    ["index", 0o644],
    ["pre-tool-use", 0o644],
    ["pre-tool-use-main", 0o755],
    ["status", 0o755],
    ["control", 0o755],
  ]) {
    await chmod(join(outdir, `${entry}.cjs`), mode);
  }
}

export async function writeNativeLoader(outdir, environment) {
  const targets = Object.fromEntries(
    Object.keys(nativePackages).map((platform) => [platform, `./native/${platform}/atbash.node`]),
  );
  // Production ships the SDK's own defaults untouched. Other environments pin
  // their judge endpoint and chains over the defaults the SDK routes with.
  const exportsSource =
    environment.endpoint === undefined
      ? "module.exports = require(target);"
      : `const native = require(target);
const chains = ${JSON.stringify(environment.chains, null, 2)};
module.exports = {
  ...native,
  DEFAULT_ENDPOINT: ${JSON.stringify(environment.endpoint)},
  DEFAULT_BLOCKCHAIN_RID: chains.public.blockchainRid,
  DEFAULT_PRIVATE_BLOCKCHAIN_RID: chains.private.blockchainRid,
  defaultChromiaNodeUrls: () => [...chains.public.nodeUrls],
  defaultPrivateNodeUrls: () => [...chains.private.nodeUrls],
};`;
  const source = `"use strict";
const key = process.platform + "-" + process.arch;
const targets = ${JSON.stringify(targets, null, 2)};
const target = targets[key];
if (target === undefined) {
  throw new Error("Atbash does not publish a native SDK for " + key + ".");
}
${exportsSource}
`;

  await writeFile(join(outdir, "atbash-native.cjs"), source, "utf8");
  await chmod(join(outdir, "atbash-native.cjs"), 0o644);
}
