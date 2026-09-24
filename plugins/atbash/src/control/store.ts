import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { ControlHost, ControlPurpose } from "./protocol.js";

export interface PendingJob {
  schemaVersion: 1;
  jobId: string;
  host: ControlHost;
  purpose: ControlPurpose;
  serviceOrigin: string;
  sessionId: string;
  sessionSecret: string;
  verificationCode: string;
  verificationUri: string;
  expiresAt: string;
  pollIntervalMs: number;
  keyDeliveryPrivateKeyPem: string;
  proposalId?: string;
  executionId?: string;
  activatedProfileId?: string;
  activatedAt?: string;
}

export interface AgentCredential {
  schemaVersion: 1;
  credentialId: string;
  agentPrivateKey: string;
  agentPubkey: string;
  createdAt: string;
}

export interface AgentProfile {
  schemaVersion: 1;
  profileId: string;
  credentialId: string;
  host: ControlHost;
  organization: string;
  network: "public" | "private";
  agentPubkey: string;
  serviceOrigin: string;
  createdAt: string;
}

export function configRoot(env = process.env): string {
  return resolve(env.ATBASH_CONFIG_DIR?.trim() || join(homedir(), ".config", "atbash"));
}

function assertSafeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error(`Invalid ${label}.`);
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error(`Refusing symlinked sensitive path: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function secureDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await rejectSymlink(parent);
  await rejectSymlink(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function atomicSecretJson(path: string, value: unknown): Promise<void> {
  await secureDirectory(dirname(path));
  await rejectSymlink(path);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  if (process.platform !== "win32") await chmod(temp, 0o600);
  await rename(temp, path);
}

async function readSecretJson<T>(path: string): Promise<T> {
  await rejectSymlink(path);
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Sensitive state is not a regular file.");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error(`Sensitive state has unsafe permissions: ${path}`);
    }
    return JSON.parse(await handle.readFile("utf8")) as T;
  } finally {
    await handle.close();
  }
}

function inside(root: string, path: string): boolean {
  const normalized = resolve(path);
  return normalized === root || normalized.startsWith(`${root}${sep}`);
}

export class ControlStore {
  readonly root: string;

  constructor(root = configRoot()) {
    this.root = resolve(root);
  }

  private path(kind: "pending" | "credentials" | "profiles" | "hosts", id: string): string {
    assertSafeId(id, `${kind} identifier`);
    const path = join(this.root, kind, `${id}.json`);
    if (!inside(this.root, path)) throw new Error("Sensitive state path escaped its root.");
    return path;
  }

  async saveJob(job: PendingJob): Promise<void> {
    await atomicSecretJson(this.path("pending", job.jobId), job);
  }

  async readJob(jobId: string): Promise<PendingJob> {
    return readSecretJson<PendingJob>(this.path("pending", jobId));
  }

  async removeJob(jobId: string): Promise<void> {
    await rm(this.path("pending", jobId), { force: true });
  }

  async activate(input: { credential: AgentCredential; profile: AgentProfile }): Promise<void> {
    await atomicSecretJson(
      this.path("credentials", input.credential.credentialId),
      input.credential,
    );
    await atomicSecretJson(this.path("profiles", input.profile.profileId), input.profile);
    await atomicSecretJson(this.path("hosts", input.profile.host), {
      schemaVersion: 1,
      profileId: input.profile.profileId,
    });
  }

  async selectedProfile(
    host: ControlHost,
  ): Promise<{ profile: AgentProfile; credential: AgentCredential } | null> {
    try {
      const selected = await readSecretJson<{ schemaVersion: 1; profileId: string }>(
        this.path("hosts", host),
      );
      const profile = await readSecretJson<AgentProfile>(this.path("profiles", selected.profileId));
      const credential = await readSecretJson<AgentCredential>(
        this.path("credentials", profile.credentialId),
      );
      return { profile, credential };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
