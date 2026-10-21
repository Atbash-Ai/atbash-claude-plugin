import { copyFile, mkdir } from "node:fs/promises";
import process from "node:process";

import {
  bundleAtbash,
  nativePackages,
  resolveEnvironmentSdk,
  selectBuildEnvironment,
  writeNativeLoader,
} from "./build-lib.mjs";

const environment = selectBuildEnvironment();
const platform = `${process.platform}-${process.arch}`;
const nativePackage = nativePackages[platform];

if (nativePackage === undefined) {
  throw new Error(`Atbash does not publish a native SDK for ${process.platform}-${process.arch}.`);
}

const nativeBindingPath = resolveEnvironmentSdk(environment).require.resolve(nativePackage);

await bundleAtbash("dist", { environment });
await writeNativeLoader("dist", environment);
await mkdir(`dist/native/${platform}`, { recursive: true });
await copyFile(nativeBindingPath, `dist/native/${platform}/atbash.node`);
