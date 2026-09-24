#!/usr/bin/env node

import { runControl } from "./control/cli.js";

try {
  const result = await runControl();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ error: error instanceof Error ? error.message : "Atbash setup failed." })}\n`,
  );
  process.exitCode = 1;
}
