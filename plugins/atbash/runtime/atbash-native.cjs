"use strict";
const key = process.platform + "-" + process.arch;
const targets = {
  "darwin-arm64": "./native/darwin-arm64/atbash.node",
  "linux-arm64": "./native/linux-arm64/atbash.node",
  "linux-x64": "./native/linux-x64/atbash.node",
  "win32-x64": "./native/win32-x64/atbash.node"
};
const target = targets[key];
if (target === undefined) {
  throw new Error("Atbash does not publish a native SDK for " + key + ".");
}
module.exports = require(target);
