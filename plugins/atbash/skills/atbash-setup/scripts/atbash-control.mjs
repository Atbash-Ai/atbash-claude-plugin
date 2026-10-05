#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = resolve(here, "../../../runtime/control.cjs");
const child = spawn(process.execPath, [runtime, ...process.argv.slice(2)], { stdio: "inherit" });
child.once("error", () => {
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
