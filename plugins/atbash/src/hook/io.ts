import type { Readable } from "node:stream";

export const MAX_HOOK_INPUT_BYTES = 1_048_576;

export async function readHookInput(
  stream: Readable,
  maxBytes = MAX_HOOK_INPUT_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error("Hook input exceeds the maximum supported size.");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}
