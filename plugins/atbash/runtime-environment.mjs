import { readFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

// Prints the environment the committed runtime was built for. With
// `--require <name>`, exits non-zero unless the runtime matches it.
const manifest = JSON.parse(
  readFileSync(new URL("./runtime/manifest.json", import.meta.url), "utf8"),
);
const environment = typeof manifest.environment === "string" ? manifest.environment : "unknown";
const requireIndex = process.argv.indexOf("--require");

if (requireIndex === -1) {
  process.stdout.write(`${environment}\n`);
} else {
  const expected = process.argv[requireIndex + 1];
  if (environment !== expected) {
    process.stderr.write(
      `plugins/atbash/runtime was built for "${environment}", but this branch must ship "${expected}". ` +
        `Rebuild it with ${expected === "prod" ? "npm run build:marketplace" : `npm run build:marketplace:${expected}`} and commit runtime/.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`plugins/atbash/runtime is a ${environment} build.\n`);
}
