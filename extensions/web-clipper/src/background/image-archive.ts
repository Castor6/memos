import { ClientError, InstanceError } from "@/lib/errors";
import { markdownImageUrls, replaceMarkdownImages } from "@/lib/markdown-images";
import { attachmentMarkdownUrl, type CreatedAttachment, createAttachment, getAttachment, type MemosCredentials } from "@/lib/memos-client";

export type ImageArchiveEntry = {
  source: string;
  id: string;
  status: "new" | "pending" | "uploaded" | "failed";
  attachment?: CreatedAttachment;
  reason?: string;
};

const ARCHIVE_IMAGE_LIMIT = 100;

/** IDs stay stable when local progress is lost; a single source has one attachment per save. */
export async function imageArchivePlan(content: string, requestKey: string): Promise<ImageArchiveEntry[]> {
  const sources = markdownImageUrls(content).filter((source) => !/^\/file\/attachments\/[^/]+\/[^/]+$/.test(source));
  return Promise.all(
    sources.map(async (source) => {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${requestKey}\n${source}`));
      const id = `clip${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 32)}`;
      return { source, id, status: "new" as const };
    }),
  );
}

export function recoveredImageContent(
  content: string,
  plan: ImageArchiveEntry[],
  attachments: Array<{ name: string; filename?: string }>,
): string {
  const replacements = new Map<string, string>();
  for (const entry of plan) {
    const attachment = attachments.find((attachment) => attachment.name === `attachments/${entry.id}`);
    if (attachment?.filename) replacements.set(entry.source, attachmentMarkdownUrl({ ...attachment, filename: attachment.filename }));
  }
  return replaceMarkdownImages(content, replacements);
}

/** Persist each upload boundary before progressing; never repeat a POST with an unknown result. */
export async function archiveMarkdownImages(
  content: string,
  plan: ImageArchiveEntry[],
  credentials: MemosCredentials,
  persist: (entries: ImageArchiveEntry[]) => Promise<void>,
  stillCurrent: () => Promise<boolean>,
): Promise<{ content: string; names: string[]; failures: Array<{ url: string; reason: string }> }> {
  const entries = plan.map((entry) => ({ ...entry }));
  const checkConnection = async () => {
    if (!(await stillCurrent())) throw new ClientError("auth-changed");
  };
  for (const [index, entry] of entries.entries()) {
    if (entry.status === "uploaded" || entry.status === "failed") continue;
    await checkConnection();
    if (entry.status === "pending") {
      const recovered = await getAttachment(credentials, entry.id);
      if (recovered) {
        entry.attachment = recovered;
        entry.status = "uploaded";
        await persist(entries);
        continue;
      }
    }
    const source = validImageSource(entry.source);
    let downloaded: Awaited<ReturnType<typeof readImageBytes>> = null;
    if (!source) entry.reason = "图片地址或格式不支持转存";
    else if (index >= ARCHIVE_IMAGE_LIMIT) entry.reason = `超过单次 ${ARCHIVE_IMAGE_LIMIT} 张转存上限`;
    else {
      try {
        const response = await fetch(source, {
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
        });
        if (response.ok) downloaded = await readImageBytes(response);
        if (!downloaded) entry.reason = "原站下载失败、格式不支持或图片超过 10 MiB";
      } catch {
        entry.reason = "原站下载失败或超时";
      }
    }
    await checkConnection();
    if (downloaded) {
      entry.status = "pending";
      await persist(entries);
      try {
        const attachment = await createAttachment(credentials, {
          attachmentId: entry.id,
          filename: `clip-${entry.id.slice(4, 12)}.${downloaded.type.split("/")[1]}`,
          type: downloaded.type,
          content: bytesToBase64(downloaded.bytes),
        });
        if (attachment.name !== `attachments/${entry.id}`) throw new InstanceError("bad-response");
        entry.attachment = attachment;
      } catch (error) {
        await checkConnection();
        // GET failure leaves this entry pending. A later save first reconciles the same ID.
        // A confirmed absence can fall back to its original URL while the text is saved.
        if (error instanceof InstanceError && ["unauthorized", "invalid-content", "content-too-large"].includes(error.kind)) {
          entry.reason = "Memos 未接受图片上传";
        } else {
          entry.attachment = (await getAttachment(credentials, entry.id)) ?? undefined;
          if (!entry.attachment) entry.reason = "Memos 图片上传失败";
        }
      }
    }
    entry.status = entry.attachment ? "uploaded" : "failed";
    await persist(entries);
  }
  const replacements = new Map<string, string>();
  const names: string[] = [];
  const failures: Array<{ url: string; reason: string }> = [];
  for (const entry of entries) {
    if (entry.attachment) {
      names.push(entry.attachment.name);
      replacements.set(entry.source, attachmentMarkdownUrl(entry.attachment));
    } else failures.push({ url: entry.source, reason: entry.reason ?? "图片未能转存" });
  }
  return { content: replaceMarkdownImages(content, replacements), names, failures };
}

const MAX_IMAGES_PER_CLIP = 10;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 8_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DATA_URL_LENGTH = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 1024;
const SAFE_IMAGE_TYPES = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);
const PRIVATE_HOST_SUFFIXES = [".corp", ".home", ".internal", ".lan", ".local", ".localdomain"];

function blockedIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function blockedImageHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal" ||
    PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return true;
  }
  if (blockedIpv4(host)) return true;
  // Single-label hostnames normally resolve through a private DNS search domain. IPv4-mapped
  // IPv6 literals are blocked as a class so alternate spellings cannot bypass the IPv4 ranges.
  if (!host.includes(".") && !host.includes(":")) return true;
  return (
    host.includes(":") && (host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || /(^|:)ffff:/.test(host))
  );
}

function validImageSource(srcUrl: string): URL | null {
  if (!srcUrl || srcUrl.length > MAX_DATA_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(srcUrl);
  } catch {
    return null;
  }
  if (url.protocol === "data:") return /^data:image\/[a-z0-9.+-]+[;,]/i.test(srcUrl) ? url : null;
  if (url.protocol !== "https:" || url.username || url.password || blockedImageHostname(url.hostname)) return null;
  return url;
}

export async function readImageBytes(response: Response): Promise<{ bytes: Uint8Array; type: string } | null> {
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  // SVG and arbitrary image/* subtypes can carry active content. Only passive raster formats
  // that browsers and Memos serve safely are accepted as attachments.
  if (!SAFE_IMAGE_TYPES.has(type)) return null;

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) return null;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength <= MAX_IMAGE_BYTES ? { bytes, type } : null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, type };
}

export async function uploadImages(
  images: string[],
  credentials: MemosCredentials,
  stillCurrent?: () => Promise<boolean>,
): Promise<{ names: string[]; failed: number }> {
  const capped = images.slice(0, MAX_IMAGES_PER_CLIP);
  const names: string[] = [];
  // Sequential downloads keep the peak memory bounded to one decoded/base64 image.
  for (const src of capped) {
    if (stillCurrent && !(await stillCurrent())) break;
    const name = await uploadImageAttachment(src, credentials, stillCurrent);
    if (name) names.push(name);
  }
  return { names, failed: images.length - names.length };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function imageFilename(srcUrl: string, type: string): string {
  try {
    const base = new URL(srcUrl).pathname.split("/").pop();
    if (base && /\.\w+$/.test(base)) return decodeURIComponent(base);
  } catch {
    // data: URL or non-URL — fall through to a generated name.
  }
  const ext = type.split("/")[1]?.split("+")[0] || "png";
  return `clip.${ext}`;
}

async function uploadImageAttachment(
  srcUrl: string,
  credentials: MemosCredentials,
  stillCurrent?: () => Promise<boolean>,
): Promise<string | null> {
  const source = validImageSource(srcUrl);
  if (!source) return null;
  try {
    const res = await fetch(source, {
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const image = await readImageBytes(res);
    if (!image) return null;
    if (stillCurrent && !(await stillCurrent())) return null;
    const content = bytesToBase64(image.bytes);
    const attachment = await createAttachment(credentials, {
      filename: imageFilename(source.toString(), image.type),
      type: image.type,
      content,
    });
    return attachment.name;
  } catch (error) {
    const errorName = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "Error";
    console.warn("[memos-web-clipper] image attachment failed", { origin: source.origin, errorName });
    return null;
  }
}
