import assert from "node:assert/strict";
import test from "node:test";

import { PLUGIN_DISPLAY_NAME, PLUGIN_ID } from "../src/index.js";
import { resolveOrgName } from "../src/atbash/guard.js";

test("exports the accepted plugin identity", () => {
  assert.equal(PLUGIN_ID, "atbash");
  assert.equal(PLUGIN_DISPLAY_NAME, "Atbash Safety");
});

test("normalizes the configured organization before SDK construction", () => {
  assert.equal(resolveOrgName(" personal_org "), "personal_org");
  assert.equal(resolveOrgName(""), undefined);
  assert.equal(resolveOrgName("   "), undefined);
});
