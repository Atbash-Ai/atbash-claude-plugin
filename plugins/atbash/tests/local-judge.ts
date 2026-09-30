/**
 * A real judge on loopback for tests that run the BUILT hook: an HTTP server answering the three
 * routes the SDK calls for one judgment, optionally slow, with its /api/v1/judge answers signed the
 * way a self-hosted Atbash judge signs them (X-Atbash-Signature: secp256k1 ECDSA over SHA-256 of the
 * exact body, low-S, compact r||s hex). Nothing in the hook or the SDK is replaced: the hook talks to
 * this server over TCP and the SDK verifies the signature with its own native code.
 *
 * A loopback judge is accepted only with ATBASH_DEV_ALLOW_LOCAL_JUDGE=1 AND a response-signing key
 * (ATBASH_JUDGE_VERIFY_PUBKEY), so `env` carries all three; `unsafeEnv` is the endpoint alone, the
 * shape an attacker's fake judge would have.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";

export interface LocalJudgeOptions {
  delayMs?: number;
  verdict?: "ALLOW" | "BLOCK";
  /** "valid" (default): signed with this judge's key; "none": no header; "foreign": another key. */
  signature?: "valid" | "none" | "foreign";
  /** The `allow` field of an ALLOW answer (default true); false makes the answer inconsistent. */
  allowField?: boolean;
}

export interface LocalJudge {
  endpoint: string;
  hits: string[];
  verifyPubKey: string;
  /** Endpoint, verify key and the dev flag: what a developer's local judge needs. */
  env: Record<string, string>;
  /** The endpoint alone: what a fake judge planted by an attacker would look like. */
  unsafeEnv: Record<string, string>;
  close(): Promise<void>;
}

const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

function compressedPubKey(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" });
  const x = Buffer.from(jwk.x ?? "", "base64url");
  const y = Buffer.from(jwk.y ?? "", "base64url");
  return ((y[y.length - 1] ?? 0) % 2 === 0 ? "02" : "03") + x.toString("hex");
}

function signBody(body: Buffer, privateKey: KeyObject): string {
  const raw = sign("sha256", body, { key: privateKey, dsaEncoding: "ieee-p1363" });
  const r = raw.subarray(0, 32);
  let s = BigInt(`0x${raw.subarray(32).toString("hex")}`);
  // libsecp256k1 accepts only low-S signatures; OpenSSL does not normalise.
  if (s > SECP256K1_N / 2n) s = SECP256K1_N - s;
  return r.toString("hex") + s.toString(16).padStart(64, "0");
}

/** A response-signing key like a self-hosted judge's, for fixtures that build their own server. */
export function createJudgeSigner(): { verifyPubKey: string; sign(body: Buffer): string } {
  const keys = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  return {
    verifyPubKey: compressedPubKey(keys.publicKey),
    sign: (body) => signBody(body, keys.privateKey),
  };
}

export async function startLocalJudge(options: LocalJudgeOptions = {}): Promise<LocalJudge> {
  const { delayMs = 0, verdict = "ALLOW", signature = "valid", allowField = true } = options;
  const keys = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const foreign = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const verifyPubKey = compressedPubKey(keys.publicKey);
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    hits.push(`${req.method} ${url.pathname}`);
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const answer = (payload: unknown, signed = false) =>
        setTimeout(() => {
          const body = Buffer.from(JSON.stringify(payload));
          if (signed && signature !== "none") {
            res.setHeader(
              "X-Atbash-Signature",
              signBody(body, signature === "foreign" ? foreign.privateKey : keys.privateKey),
            );
          }
          res.end(body);
        }, delayMs);
      if (url.pathname === "/api/ai/exists") {
        answer({
          registered: true,
          pubkey: url.searchParams.get("pubkey"),
          org_encryption_pubkey: null,
        });
      } else if (url.pathname === "/api/risk-engine") {
        answer({ policy: "", is_custom: false, default_policy: "default", is_jailed: false });
      } else if (url.pathname === "/api/v1/judge") {
        answer(
          verdict === "BLOCK"
            ? {
                verdict: "BLOCK",
                action_type: "block",
                allow: false,
                reason: "denied by the test judge",
                tool_call_id: "tc-1",
              }
            : {
                verdict: "ALLOW",
                action_type: "allow",
                allow: allowField,
                reason: "routine",
                tool_call_id: "tc-1",
              },
          true,
        );
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const endpoint = `http://127.0.0.1:${port}`;
  return {
    endpoint,
    hits,
    verifyPubKey,
    env: {
      ATBASH_ENDPOINT: endpoint,
      ATBASH_JUDGE_VERIFY_PUBKEY: verifyPubKey,
      ATBASH_DEV_ALLOW_LOCAL_JUDGE: "1",
    },
    unsafeEnv: { ATBASH_ENDPOINT: endpoint },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  wallMs: number;
}

/**
 * Run the BUILT entry point (dist/pre-tool-use.cjs) the way the host does: a fresh process, the
 * payload on stdin, a clean environment with its own HOME so no developer configuration leaks in.
 */
export function runBuiltHook(
  payload: unknown,
  env: Record<string, string>,
  home: string,
  entry = "dist/pre-tool-use.cjs",
): Promise<HookRun> {
  const started = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
        HOME: home,
        USERPROFILE: home,
        HONEYCOMB_API_KEY: "",
        ATBASH_TELEMETRY_DISABLED: "1",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout,
        stderr,
        wallMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
      }),
    );
    child.stdin.end(JSON.stringify(payload));
  });
}
