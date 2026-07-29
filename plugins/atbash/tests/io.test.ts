import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { readHookInput } from "../src/hook/io.js";

test("reads hook input up to the configured byte limit", async () => {
  assert.equal(await readHookInput(Readable.from(["abcd"]), 4), "abcd");
});

test("rejects hook input that exceeds the configured byte limit", async () => {
  await assert.rejects(readHookInput(Readable.from(["abc", "de"]), 4), /exceeds/);
});
