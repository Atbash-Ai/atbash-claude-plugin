import { DEFAULT_ENDPOINT } from "@atbash/sdk";
import type {
  ControlHost,
  ControlPurpose,
  CreatedSession,
  ExecutionView,
  KeyDeliveryPublicKey,
  ProposalAction,
  ProposalView,
  SessionView,
  SetupInventory,
} from "./protocol.js";
import {
  parseCreatedSession,
  parseExecutionEnvelope,
  parseProposalEnvelope,
  parseResources,
  parseSessionView,
} from "./protocol.js";

// Pair with the same Atbash service the bundled SDK judges against.
export const DEFAULT_CONTROL_ORIGIN = new URL(DEFAULT_ENDPOINT).origin;
const DEFAULT_TIMEOUT_MS = 15_000;

export class ControlApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export function resolveControlOrigin(raw = process.env.ATBASH_CONTROL_ORIGIN): string {
  const candidate = (raw ?? DEFAULT_CONTROL_ORIGIN).trim();
  const url = new URL(candidate);
  const local =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("ATBASH_CONTROL_ORIGIN must use HTTPS (HTTP is allowed only for localhost). ");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("ATBASH_CONTROL_ORIGIN is invalid.");
  return url.origin;
}

export class ControlClient {
  constructor(
    private readonly origin = resolveControlOrigin(),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit = {}, secret?: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await this.fetcher(new URL(path, this.origin), {
        ...init,
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
          ...init.headers,
        },
      });
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      if (!response.ok) {
        const safeMessage =
          typeof body.error === "string" ? body.error : `Atbash returned HTTP ${response.status}.`;
        throw new ControlApiError(safeMessage, response.status);
      }
      return body;
    } catch (error) {
      if (error instanceof ControlApiError) throw error;
      if (error instanceof Error && error.name === "AbortError")
        throw new ControlApiError("Atbash request timed out.");
      throw new ControlApiError("Atbash could not be reached.");
    } finally {
      clearTimeout(timeout);
    }
  }

  async createSession(input: {
    host: ControlHost;
    purpose: ControlPurpose;
    clientVersion: string;
    deviceName?: string;
    keyDeliveryPublicKey: KeyDeliveryPublicKey;
  }): Promise<CreatedSession> {
    return parseCreatedSession(
      await this.request("/api/v1/plugin/sessions", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }

  async getSession(sessionId: string, secret: string): Promise<SessionView> {
    return parseSessionView(
      await this.request(`/api/v1/plugin/sessions/${encodeURIComponent(sessionId)}`, {}, secret),
    );
  }

  async cancelSession(sessionId: string, secret: string): Promise<void> {
    await this.request(
      `/api/v1/plugin/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
      secret,
    );
  }

  async getResources(sessionId: string, secret: string): Promise<SetupInventory | null> {
    return parseResources(
      await this.request(
        `/api/v1/plugin/sessions/${encodeURIComponent(sessionId)}/resources`,
        {},
        secret,
      ),
    ).discovery;
  }

  async submitProposal(
    sessionId: string,
    secret: string,
    actions: ProposalAction[],
  ): Promise<ProposalView> {
    return (await this.request(
      `/api/v1/plugin/sessions/${encodeURIComponent(sessionId)}/proposal`,
      { method: "POST", body: JSON.stringify({ actions }) },
      secret,
    )) as ProposalView;
  }

  async getProposal(sessionId: string, secret: string): Promise<ProposalView | null> {
    return parseProposalEnvelope(
      await this.request(
        `/api/v1/plugin/sessions/${encodeURIComponent(sessionId)}/proposal`,
        {},
        secret,
      ),
    ).proposal;
  }

  async getExecution(
    sessionId: string,
    executionId: string,
    secret: string,
  ): Promise<ExecutionView | null> {
    return parseExecutionEnvelope(
      await this.request(
        `/api/v1/plugin/sessions/${encodeURIComponent(sessionId)}/execution/${encodeURIComponent(executionId)}`,
        {},
        secret,
      ),
    ).execution;
  }

  async getLatestExecution(sessionId: string, secret: string): Promise<ExecutionView | null> {
    return parseExecutionEnvelope(
      await this.request(
        `/api/v1/plugin/sessions/${encodeURIComponent(sessionId)}/execution`,
        {},
        secret,
      ),
    ).execution;
  }
}
