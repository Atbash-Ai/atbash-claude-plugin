import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import process from "node:process";

import { bundleAtbash, nativePackages, writeNativeLoader } from "./build-lib.mjs";

const require = createRequire(import.meta.url);
const platform = `${process.platform}-${process.arch}`;
const nativePackage = nativePackages[platform];

if (nativePackage === undefined) {
  throw new Error(`Atbash does not publish a native SDK for ${process.platform}-${process.arch}.`);
}

const nativeBindingPath = require.resolve(nativePackage);

await bundleAtbash("dist");
await writeNativeLoader("dist");
await mkdir(`dist/native/${platform}`, { recursive: true });
await copyFile(nativeBindingPath, `dist/native/${platform}/atbash.node`);
