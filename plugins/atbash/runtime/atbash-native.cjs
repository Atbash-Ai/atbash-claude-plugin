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
const native = require(target);
const chains = {
  "public": {
    "blockchainRid": "02668c5218871f69a93cc0f7032dcffe06ef0d35ef2f0b07a92a3d83a3f23a7d",
    "nodeUrls": [
      "https://node0.testnet.chromia.com:7740",
      "https://node1.testnet.chromia.com:7740",
      "https://node3.testnet.chromia.com:7740"
    ]
  },
  "private": {
    "blockchainRid": "2603569ae8dc3f254323f719c8d4347bba964e874e781291f8474236be8b6493",
    "nodeUrls": [
      "https://node0-pvn-testnet.dynamic.chromia.dev",
      "https://node1-pvn-testnet.dynamic.chromia.dev",
      "https://node2-pvn-testnet.dynamic.chromia.dev"
    ]
  }
};
module.exports = {
  ...native,
  DEFAULT_ENDPOINT: "https://chromia-verified-ai-dev-two.vercel.app",
  DEFAULT_BLOCKCHAIN_RID: chains.public.blockchainRid,
  DEFAULT_PRIVATE_BLOCKCHAIN_RID: chains.private.blockchainRid,
  defaultChromiaNodeUrls: () => [...chains.public.nodeUrls],
  defaultPrivateNodeUrls: () => [...chains.private.nodeUrls],
};
