import type { AttachmentPreviewResult, PreviewConnection } from "@/lib/messages";
import { resolveActiveConnection } from "./connection-source";
import { readImageBytes } from "./image-archive";

/** Fetch only a current account's attachment, keeping credentials inside the worker. */
export async function attachmentPreview(request: PreviewConnection & { path: string }): Promise<AttachmentPreviewResult> {
  try {
    const match = /^\/file\/attachments\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\/([^/?#\\]+)$/.exec(request.path);
    if (!match) return { ok: false };
    const filename = decodeURIComponent(match[2]!);
    if (
      !filename ||
      filename === "." ||
      filename === ".." ||
      filename.includes("/") ||
      filename.includes("\\") ||
      Array.from(filename).some((character) => character.charCodeAt(0) < 32)
    )
      return { ok: false };
    const connection = await resolveActiveConnection();
    if (!connection) return { ok: false };
    const matches = (current: typeof connection | null) =>
      current &&
      current.source === request.expectedSource &&
      current.connectionId === request.expectedConnectionId &&
      current.credentials.instanceUrl === request.expectedInstanceUrl &&
      current.credentials.accessToken === connection.credentials.accessToken;
    if (!matches(connection)) return { ok: false };
    const url = new URL(request.path, connection.credentials.instanceUrl);
    if (!["https:", "http:"].includes(url.protocol)) return { ok: false };
    const response = await fetch(url.href, {
      headers: { Authorization: `Bearer ${connection.credentials.accessToken}` },
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { ok: false };
    const image = await readImageBytes(response);
    if (!image || !matches(await resolveActiveConnection())) return { ok: false };
    let binary = "";
    for (let offset = 0; offset < image.bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...image.bytes.subarray(offset, offset + 0x8000));
    }
    return { ok: true, dataUrl: `data:${image.type};base64,${btoa(binary)}` };
  } catch {
    return { ok: false };
  }
}
