import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { connectExistingAgent, type ConnectedExistingProfile } from "./existing-agent.js";
import type { ControlClient } from "./client.js";
import type { ControlStore } from "./store.js";

const MAX_BODY_BYTES = 8_192;

function securityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  );
  response.setHeader("cross-origin-resource-policy", "same-origin");
  // NOT "no-referrer": per the Fetch spec's "append a request Origin header"
  // step, a non-GET request under that policy has its serialized origin set to
  // `null`, so the browser posting this very form would send `Origin: null` and
  // the same-origin check below could never pass. "same-origin" nulls the
  // origin only cross-origin, which is exactly the case that check is for.
  response.setHeader("referrer-policy", "same-origin");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function page(csrf: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect local Atbash key</title><style>body{font:16px system-ui;background:#0b0e0d;color:#e9eee9;max-width:620px;margin:10vh auto;padding:24px}form{display:grid;gap:16px}input,button{font:inherit;padding:12px;border-radius:8px}input{background:#151a18;color:#fff;border:1px solid #405049}button{border:0;background:#63d6ad;color:#07120e;font-weight:700}small{color:#96a29c}</style></head><body><h1>Connect an existing Atbash agent</h1><p>Enter the agent private key here. It stays in this local helper and is never sent to the dashboard.</p><form method="post"><input type="hidden" name="csrf" value="${csrf}"><label>Agent private key<input name="privateKey" type="password" autocomplete="off" required maxlength="68"></label><button type="submit">Connect this agent</button></form><small>This page closes after one successful submission or ten minutes.</small></body></html>`;
}

export async function startLocalImportServer(input: {
  jobId: string;
  store?: ControlStore;
  client?: ControlClient;
  timeoutMs?: number;
}): Promise<{
  localUri: string;
  completion: Promise<ConnectedExistingProfile>;
  close: () => Promise<void>;
}> {
  const token = randomBytes(24).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  let resolveCompletion!: (profile: ConnectedExistingProfile) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<ConnectedExistingProfile>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  let expectedOrigin = "";
  const server = createServer((request, response) => {
    void (async () => {
      securityHeaders(response);
      if (request.headers.host !== new URL(expectedOrigin).host || request.url !== `/${token}`) {
        response.writeHead(404).end("Not found");
        return;
      }
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(csrf));
        return;
      }
      if (request.method !== "POST" || request.headers.origin !== expectedOrigin) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(bytes);
        size += bytes.length;
        if (size > MAX_BODY_BYTES) {
          for (const buffered of chunks) buffered.fill(0);
          response.writeHead(413).end("Request too large");
          return;
        }
      }
      const body = Buffer.concat(chunks);
      try {
        const fields = new URLSearchParams(body.toString("utf8"));
        if (fields.get("csrf") !== csrf) {
          response.writeHead(403).end("Forbidden");
          return;
        }
        const privateKey = fields.get("privateKey") ?? "";
        const profile = await connectExistingAgent({
          jobId: input.jobId,
          privateKey,
          ...(input.store ? { store: input.store } : {}),
          ...(input.client ? { client: input.client } : {}),
        });
        response
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(
            "<!doctype html><html><body><h1>Atbash agent connected</h1><p>You may close this tab and return to your assistant.</p></body></html>",
          );
        resolveCompletion(profile);
        server.close();
      } catch (error) {
        response
          .writeHead(400, { "content-type": "text/plain; charset=utf-8" })
          .end(error instanceof Error ? error.message : "The agent could not be connected.");
      } finally {
        body.fill(0);
        for (const chunk of chunks) chunk.fill(0);
      }
    })().catch((error: unknown) => {
      rejectCompletion(error instanceof Error ? error : new Error("Local key import failed."));
      response.destroy();
      server.close();
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not open the local key form.");
  expectedOrigin = `http://127.0.0.1:${address.port}`;
  const timer = setTimeout(
    () => {
      rejectCompletion(new Error("The local key form expired."));
      server.close();
    },
    input.timeoutMs ?? 10 * 60 * 1_000,
  );
  timer.unref();
  completion.finally(() => clearTimeout(timer)).catch(() => undefined);
  return {
    localUri: `${expectedOrigin}/${token}`,
    completion,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
