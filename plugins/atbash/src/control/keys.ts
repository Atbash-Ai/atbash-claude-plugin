import { constants, createPrivateKey, generateKeyPairSync, privateDecrypt } from "node:crypto";
import type { EncryptedKeyDelivery, KeyDeliveryPublicKey } from "./protocol.js";

export interface KeyDeliveryPair {
  publicKey: KeyDeliveryPublicKey;
  privateKeyPem: string;
}

export function generateKeyDeliveryPair(): KeyDeliveryPair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || jwk.e !== "AQAB") {
    throw new Error("Could not create the local key-delivery channel.");
  }
  return {
    publicKey: {
      kty: "RSA",
      alg: "RSA-OAEP-256",
      n: jwk.n,
      e: "AQAB",
      ext: true,
      key_ops: ["encrypt"],
    },
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

export function decryptAgentKey(
  delivery: EncryptedKeyDelivery,
  privateKeyPem: string,
): { agentPubkey: string; agentPrivateKey: string } {
  const plaintext = privateDecrypt(
    {
      key: createPrivateKey(privateKeyPem),
      oaepHash: "sha256",
      oaepLabel: Buffer.from(delivery.label, "utf8"),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
    },
    Buffer.from(delivery.ciphertext, "base64url"),
  );
  try {
    const parsed = JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
    const agentPubkey = String(parsed.agentPubkey ?? "").toLowerCase();
    const agentPrivateKey = String(parsed.agentPrivateKey ?? "").toLowerCase();
    if (parsed.version !== 1 || agentPubkey !== delivery.agentPubkey.toLowerCase())
      throw new Error("mismatch");
    if (!/^(02|03)[0-9a-f]{64}$/.test(agentPubkey) || !/^[0-9a-f]{64}$/.test(agentPrivateKey)) {
      throw new Error("invalid key");
    }
    return { agentPubkey, agentPrivateKey };
  } catch {
    throw new Error("The encrypted agent key could not be validated.");
  } finally {
    plaintext.fill(0);
  }
}
