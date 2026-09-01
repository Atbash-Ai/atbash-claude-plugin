import { build } from "esbuild";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const nativePackages = {
  "darwin-arm64": "@atbash/sdk-darwin-arm64",
  "linux-arm64": "@atbash/sdk-linux-arm64-gnu",
  "linux-x64": "@atbash/sdk-linux-x64-gnu",
  "win32-x64": "@atbash/sdk-win32-x64-msvc",
};

const sdkNativeMarker = 'require2("../index.js")';

export async function bundleAtbash(outdir, { minify = false, sourcemap = true } = {}) {
  await rm(outdir, { force: true, recursive: true });

  await build({
    bundle: true,
    entryPoints: {
      index: "src/index.ts",
      "pre-tool-use": "src/pre-tool-use.ts",
      status: "src/status.ts",
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
            { filter: /@atbash[\\/]sdk[\\/]dist[\\/]index\.mjs$/ },
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

  for (const entry of ["index", "pre-tool-use", "status"]) {
    const outputPath = join(outdir, `${entry}.cjs`);
    const source = await readFile(outputPath, "utf8");
    await writeFile(outputPath, source.replaceAll("\t", "  "), "utf8");
  }
}

export async function writeNativeLoader(outdir) {
  const targets = Object.fromEntries(
    Object.keys(nativePackages).map((platform) => [platform, `./native/${platform}/atbash.node`]),
  );
  const source = `"use strict";
const key = process.platform + "-" + process.arch;
const targets = ${JSON.stringify(targets, null, 2)};
const target = targets[key];
if (target === undefined) {
  throw new Error("Atbash does not publish a native SDK for " + key + ".");
}
module.exports = require(target);
`;

  await writeFile(join(outdir, "atbash-native.cjs"), source, "utf8");
}
