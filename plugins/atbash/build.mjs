import { build } from "esbuild";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const nativePackage = {
  "darwin-arm64": "@atbash/sdk-darwin-arm64",
  "linux-arm64": "@atbash/sdk-linux-arm64-gnu",
  "linux-x64": "@atbash/sdk-linux-x64-gnu",
  "win32-x64": "@atbash/sdk-win32-x64-msvc",
}[`${process.platform}-${process.arch}`];

if (nativePackage === undefined) {
  throw new Error(`Atbash does not publish a native SDK for ${process.platform}-${process.arch}.`);
}

const nativeBindingPath = require.resolve(nativePackage);
const sdkNativeMarker = 'require2("../index.js")';

await rm("dist", { force: true, recursive: true });

await build({
  bundle: true,
  entryPoints: {
    index: "src/index.ts",
    "pre-tool-use": "src/pre-tool-use.ts",
    status: "src/status.ts",
  },
  format: "cjs",
  legalComments: "none",
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  platform: "node",
  plugins: [
    {
      name: "atbash-native-loader",
      setup(esbuild) {
        esbuild.onLoad({ filter: /@atbash\/sdk\/dist\/index\.mjs$/ }, async ({ path }) => {
          const source = await readFile(path, "utf8");
          if (!source.includes(sdkNativeMarker)) {
            throw new Error("The installed Atbash SDK has an unexpected native-loader layout.");
          }

          return {
            contents: source.replace(sdkNativeMarker, 'require2("./atbash-native.cjs")'),
            loader: "js",
          };
        });
      },
    },
  ],
  sourcemap: true,
  sourcesContent: false,
  target: "node22",
});

await copyFile(nativeBindingPath, "dist/atbash.node");
await writeFile(
  "dist/atbash-native.cjs",
  '"use strict";\nmodule.exports = require("./atbash.node");\n',
  "utf8",
);
