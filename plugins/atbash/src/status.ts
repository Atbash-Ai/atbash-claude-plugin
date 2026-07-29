#!/usr/bin/env node

import { getAtbashStatus } from "./atbash/status.js";

async function main(): Promise<void> {
  const status = await getAtbashStatus();
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.exitCode = status.ready ? 0 : 1;
}

void main();
