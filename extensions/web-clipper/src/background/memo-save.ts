import browser from "webextension-polyfill";
import { OAuthUnavailableError } from "@/auth/oauth-session";
import { resolveActiveConnection } from "@/background/connection-source";
import { parseCaptureData } from "@/lib/capture-data";
import {
  type CaptureData,
  type ClipCaptureInput,
  captureCapabilities,
  normalizeClipSourceUrl,
  recordSuccessfulClip,
} from "@/lib/clip-records";
import type { ConnectionSource } from "@/lib/connection-config";
import { InstanceError, toSaveErrorKind } from "@/lib/errors";
import { composeMemoContent, toQuotedMarkdown } from "@/lib/format";
import {
  createAttachment,
  createMemo,
  getCurrentUser,
  getMemo,
  listRecentMemos,
  type MemosCredentials,
  memoWebUrl,
  type Visibility,
} from "@/lib/memos-client";
import type { SaveResult, SelectionClip } from "@/lib/messages";

export type SaveExpectation = { source: ConnectionSource; connectionId: string; instanceUrl: string };
export type SaveOperation = { requestId: string; startedAt: number; serverMemoId?: string };

export const SAVE_ATTEMPTS_KEY = "memoSaveAttemptsV1";
const ATTEMPT_TTL_MS = 15 * 60_000;
const RECONCILIATION_CLOCK_SKEW_MS = 5_000;

type AttemptRecord = {
  fingerprint: string;
  startedAt: number;
  updatedAt?: number;
  attachmentNames?: string[];
  failedImages?: number;
  result?: Extract<SaveResult, { ok: true }>;
};

type AttemptStore = Record<string, AttemptRecord>;
const inFlight = new Map<string, { fingerprint: string; promise: Promise<SaveResult> }>();
let attemptMutation = Promise.resolve();

function mutateAttempts<T>(operation: () => Promise<T>): Promise<T> {
  const result = attemptMutation.then(operation, operation);
  attemptMutation = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function clearMemoSaveAttempts(): Promise<void> {
  inFlight.clear();
  await mutateAttempts(() => browser.storage.local.remove(SAVE_ATTEMPTS_KEY));
}

async function saveFingerprint(
  content: string,
  visibility: Visibility,
  expected: SaveExpectation,
  images: string[],
  accessToken: string,
  capture?: CaptureData,
): Promise<string> {
  const value = JSON.stringify([
    content,
    visibility,
    expected.source,
    expected.connectionId,
    expected.instanceUrl,
    images,
    accessToken,
    capture,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readAttempts(): Promise<AttemptStore> {
  const stored = await browser.storage.local.get(SAVE_ATTEMPTS_KEY);
  const raw = stored[SAVE_ATTEMPTS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(raw as AttemptStore).filter(
      ([, attempt]) => attempt && now - (attempt.updatedAt ?? attempt.startedAt) <= ATTEMPT_TTL_MS,
    ),
  );
}

async function writeAttempt(requestId: string, attempt: AttemptRecord | null): Promise<void> {
  await mutateAttempts(async () => {
    const attempts = await readAttempts();
    if (attempt) attempts[requestId] = { ...attempt, updatedAt: Date.now() };
    else delete attempts[requestId];
    await browser.storage.local.set({ [SAVE_ATTEMPTS_KEY]: attempts });
  });
}

async function connectionStillMatches(expected: SaveExpectation, credentials: MemosCredentials): Promise<boolean> {
  const current = await resolveActiveConnection();
  return Boolean(
    current &&
      current.source === expected.source &&
      current.connectionId === expected.connectionId &&
      current.credentials.instanceUrl === expected.instanceUrl &&
      current.credentials.accessToken === credentials.accessToken,
  );
}

function sameCapture(actual: CaptureData | undefined, expected: CaptureData): boolean {
  const parsed = parseCaptureData(actual);
  return parsed !== null && JSON.stringify(parsed) === JSON.stringify(parseCaptureData(expected));
}

/** Source fresh credentials and reject stale optimistic identity before any external write. */
export async function savePopupMemo(
  content: string,
  visibility: Visibility,
  images: string[],
  expected: SaveExpectation,
  operation: SaveOperation = { requestId: `legacy_${Date.now()}_${Math.random().toString(36).slice(2)}`, startedAt: Date.now() },
  clip?: ClipCaptureInput,
): Promise<SaveResult> {
  let connection: Awaited<ReturnType<typeof resolveActiveConnection>>;
  try {
    connection = await resolveActiveConnection();
  } catch (error) {
    if (error instanceof OAuthUnavailableError) return { ok: false, errorKind: "auth-unavailable" };
    throw error;
  }
  if (!connection) return { ok: false, errorKind: "not-configured" };
  const { credentials } = connection;
  if (
    connection.source !== expected.source ||
    connection.connectionId !== expected.connectionId ||
    credentials.instanceUrl !== expected.instanceUrl
  ) {
    return { ok: false, errorKind: "auth-changed" };
  }
  let capture = clip?.capture;
  if (capture) {
    capture = { ...capture, sourceUrl: normalizeClipSourceUrl(capture.sourceUrl) };
    try {
      const capabilities = await captureCapabilities(connection);
      if (!capabilities.supported) return { ok: false, errorKind: "capture-unsupported" };
      if (new TextEncoder().encode(content).byteLength > capabilities.contentMaxBytes)
        return { ok: false, errorKind: "content-too-large", contentMaxBytes: capabilities.contentMaxBytes };
    } catch (error) {
      return { ok: false, errorKind: toSaveErrorKind(error) };
    }
  }
  if (!(await connectionStillMatches(expected, credentials))) return { ok: false, errorKind: "auth-changed" };
  const attemptKey = JSON.stringify([expected.source, expected.connectionId, expected.instanceUrl, operation.requestId]);
  const fingerprint = await saveFingerprint(content, visibility, expected, images, credentials.accessToken, capture);
  const running = inFlight.get(attemptKey);
  if (running) return running.fingerprint === fingerprint ? running.promise : { ok: false, errorKind: "invalid-content" };

  const save = savePopupMemoOnce(content, visibility, images, expected, operation, credentials, attemptKey, fingerprint, capture)
    .then(async (result) => {
      if (!(await connectionStillMatches(expected, credentials))) return { ok: false, errorKind: "auth-changed" } as const;
      if (result.ok && clip && !clip.capture) {
        try {
          await recordSuccessfulClip({
            connection,
            capture: clip,
            recordId: operation.requestId,
            memoContent: content,
            visibility,
            memoUrl: result.webUrl,
          });
        } catch (error) {
          const errorName = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "Error";
          console.warn("[memos-web-clipper] local clip history write failed", { errorName });
        }
      }
      return result;
    })
    .catch(
      (error): SaveResult => ({
        ok: false,
        errorKind: error instanceof OAuthUnavailableError ? "auth-unavailable" : toSaveErrorKind(error),
      }),
    )
    .finally(() => {
      if (inFlight.get(attemptKey)?.promise === save) inFlight.delete(attemptKey);
    });
  inFlight.set(attemptKey, { fingerprint, promise: save });
  return save;
}

async function savePopupMemoOnce(
  content: string,
  visibility: Visibility,
  images: string[],
  expected: SaveExpectation,
  operation: SaveOperation,
  credentials: MemosCredentials,
  attemptKey: string,
  fingerprint: string,
  capture?: CaptureData,
): Promise<SaveResult> {
  const previous = (await readAttempts())[attemptKey];
  if (previous && previous.fingerprint !== fingerprint) return { ok: false, errorKind: "bad-response" };
  if (previous?.result && !operation.serverMemoId) return previous.result;

  // Stable capture IDs must be checked even after local retry state expires or is cleared.
  // This also avoids uploading attachments again for a previously completed remote save.
  if (previous || (capture && operation.serverMemoId)) {
    try {
      const exact = operation.serverMemoId ? await getMemo(credentials, operation.serverMemoId) : null;
      if (operation.serverMemoId && previous?.result && !exact) return { ok: false, errorKind: "not-found" };
      const currentUser = exact || !operation.serverMemoId ? await getCurrentUser(credentials) : null;
      const recent = operation.serverMemoId ? (exact ? [exact] : []) : await listRecentMemos(credentials, 20, currentUser?.name);
      const match = recent.find(
        (memo) =>
          memo.creator === currentUser?.name &&
          (capture
            ? sameCapture(memo.capture, capture) && (previous?.result || (memo.content === content && memo.visibility === visibility))
            : memo.content === content && memo.visibility === visibility) &&
          (operation.serverMemoId || Date.parse(memo.createTime) >= operation.startedAt - RECONCILIATION_CLOCK_SKEW_MS),
      );
      if (match) {
        const failedImages = previous?.failedImages ?? Math.max(0, images.length - (match.attachments?.length ?? 0));
        const result: Extract<SaveResult, { ok: true }> = {
          ok: true,
          webUrl: memoWebUrl(credentials.instanceUrl, match),
          ...(failedImages ? { failedImages } : {}),
        };
        await writeAttempt(attemptKey, { fingerprint, startedAt: operation.startedAt, ...previous, result });
        return result;
      }
      if (exact) return { ok: false, errorKind: "invalid-content", message: "保存标识已对应其他内容，请重新发起保存。" };
    } catch (error) {
      // Do not issue another create while reconciliation itself is unavailable.
      return { ok: false, errorKind: toSaveErrorKind(error) };
    }
  }

  let attempt: AttemptRecord = previous ?? { fingerprint, startedAt: operation.startedAt };
  await writeAttempt(attemptKey, attempt);

  let names = attempt.attachmentNames;
  let failed = attempt.failedImages ?? 0;
  if (!names) {
    const uploaded = await uploadImages(images, credentials, () => connectionStillMatches(expected, credentials));
    names = uploaded.names;
    failed = uploaded.failed;
    attempt = { ...attempt, attachmentNames: names, failedImages: failed };
    await writeAttempt(attemptKey, attempt);
  }

  if (!(await connectionStillMatches(expected, credentials))) return { ok: false, errorKind: "auth-changed" };
  const result = await createMemoWithAttachments(content, names, credentials, visibility, operation.serverMemoId, capture);
  if (result.ok) {
    const success = failed > 0 ? { ...result, failedImages: failed } : result;
    await writeAttempt(attemptKey, { ...attempt, result: success });
    return success;
  }

  // Keep only outcomes where the POST may have reached the server. Definite precondition/auth
  // failures start a clean operation on the next attempt.
  if (!new Set(["timeout", "cors", "unreachable", "bad-response"]).has(result.errorKind)) {
    await writeAttempt(attemptKey, null);
  }
  return result;
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
  return host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || /(^|:)ffff:/.test(host);
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

async function readImageBytes(response: Response): Promise<{ bytes: Uint8Array; type: string } | null> {
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

async function uploadImages(
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

export async function saveSelectionClip(
  clip: SelectionClip,
  title: string,
  url: string,
  credentials: MemosCredentials,
  template: string | null,
): Promise<SaveResult> {
  const { names, failed } = await uploadImages(clip.images, credentials);
  if (!clip.markdown && names.length === 0) return { ok: false, errorKind: "bad-response" };
  const content = composeMemoContent({
    bodyMarkdown: toQuotedMarkdown(clip.markdown),
    title,
    url,
    description: clip.description,
    template,
  });
  const result = await createMemoWithAttachments(content, names, credentials, "PRIVATE");
  return result.ok && failed > 0 ? { ...result, failedImages: failed } : result;
}

async function createMemoWithAttachments(
  content: string,
  attachmentNames: string[],
  credentials: MemosCredentials,
  visibility: Visibility,
  memoId?: string,
  capture?: CaptureData,
): Promise<SaveResult> {
  try {
    const memo = await createMemo(credentials, {
      content,
      visibility,
      ...(capture ? { capture } : {}),
      ...(memoId ? { memoId } : {}),
      ...(attachmentNames.length ? { attachments: attachmentNames.map((name) => ({ name })) } : {}),
    });
    return { ok: true, webUrl: memoWebUrl(credentials.instanceUrl, memo) };
  } catch (error) {
    const errorKind = toSaveErrorKind(error);
    const errorName = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "Error";
    console.error("[memos-web-clipper] save failed", { errorKind, errorName });
    return { ok: false, errorKind, ...(error instanceof InstanceError && error.message !== error.kind ? { message: error.message } : {}) };
  }
}
