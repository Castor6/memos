import browser from "webextension-polyfill";
import { OAuthUnavailableError } from "@/auth/oauth-session";
import { resolveActiveConnection } from "@/background/connection-source";
import {
  archiveMarkdownImages,
  type ImageArchiveEntry,
  imageArchivePlan,
  recoveredImageContent,
  uploadImages,
} from "@/background/image-archive";
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
import { estimatedArchivedBytes, markdownImageUrls } from "@/lib/markdown-images";
import {
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
export type SaveOperation = { requestId: string; startedAt: number; serverMemoId?: string; isRetry?: boolean; inlineImages?: boolean };

export const SAVE_ATTEMPTS_KEY = "memoSaveAttemptsV1";
const ATTEMPT_TTL_MS = 15 * 60_000;
const RECONCILIATION_CLOCK_SKEW_MS = 5_000;

type AttemptRecord = {
  fingerprint: string;
  startedAt: number;
  updatedAt?: number;
  attachmentNames?: string[];
  failedImages?: number;
  failedImageDetails?: Array<{ url: string; reason: string }>;
  imageEntries?: ImageArchiveEntry[];
  inlineImages?: boolean;
  memoContent?: string;
  memoCreationStarted?: boolean;
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
  tags?: string[],
  inlineImages = false,
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
    ...(tags !== undefined ? [tags] : []),
    ...(inlineImages ? ["inline-images-v1"] : []),
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
  tags?: string[],
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
  let contentMaxBytes: number | undefined;
  if (capture) {
    capture = { ...capture, sourceUrl: normalizeClipSourceUrl(capture.sourceUrl) };
    try {
      const capabilities = await captureCapabilities(connection);
      contentMaxBytes = capabilities.contentMaxBytes;
      if (!capabilities.supported) return { ok: false, errorKind: "capture-unsupported" };
      if (
        (operation.inlineImages ? estimatedArchivedBytes(content) : new TextEncoder().encode(content).byteLength) >
        capabilities.contentMaxBytes
      )
        return { ok: false, errorKind: "content-too-large", contentMaxBytes: capabilities.contentMaxBytes };
    } catch (error) {
      return { ok: false, errorKind: toSaveErrorKind(error) };
    }
  }
  if (!(await connectionStillMatches(expected, credentials))) return { ok: false, errorKind: "auth-changed" };
  const attemptKey = JSON.stringify([expected.source, expected.connectionId, expected.instanceUrl, operation.requestId]);
  const fingerprint = await saveFingerprint(
    content,
    visibility,
    expected,
    images,
    credentials.accessToken,
    capture,
    tags,
    operation.inlineImages,
  );
  const running = inFlight.get(attemptKey);
  if (running) return running.fingerprint === fingerprint ? running.promise : { ok: false, errorKind: "invalid-content" };

  const save = savePopupMemoOnce(
    content,
    visibility,
    images,
    expected,
    operation,
    credentials,
    attemptKey,
    fingerprint,
    capture,
    tags,
    contentMaxBytes,
  )
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
  tags?: string[],
  contentMaxBytes?: number,
): Promise<SaveResult> {
  const previous = (await readAttempts())[attemptKey];
  if (previous && previous.fingerprint !== fingerprint) return { ok: false, errorKind: "bad-response" };
  if (previous?.result && !operation.serverMemoId) return previous.result;

  const imagePlan = operation.inlineImages ? (previous?.imageEntries ?? (await imageArchivePlan(content, attemptKey))) : [];

  // Stable capture IDs must be checked even after local retry state expires or is cleared.
  // This also avoids uploading attachments again for a previously completed remote save.
  if (previous || (capture && operation.serverMemoId)) {
    try {
      const exact = operation.serverMemoId ? await getMemo(credentials, operation.serverMemoId) : null;
      // An unknown save may already have been created and subsequently deleted. A retry
      // may confirm an existing memo, but only an explicit new operation may create one.
      if (
        operation.serverMemoId &&
        !exact &&
        (previous?.result || (capture && operation.isRetry && !(previous?.inlineImages && !previous.memoCreationStarted)))
      ) {
        return { ok: false, errorKind: "not-found" };
      }
      const currentUser = exact || !operation.serverMemoId ? await getCurrentUser(credentials) : null;
      const recent = operation.serverMemoId ? (exact ? [exact] : []) : await listRecentMemos(credentials, 20, currentUser?.name);
      const expectedContent = (memo: (typeof recent)[number]) =>
        previous?.memoContent ?? (operation.inlineImages ? recoveredImageContent(content, imagePlan, memo.attachments ?? []) : content);
      const match = recent.find(
        (memo) =>
          memo.creator === currentUser?.name &&
          (tags === undefined ||
            (capture && previous?.result) ||
            ((memo.tags ?? []).length === tags.length && tags.every((tag) => memo.tags?.includes(tag)))) &&
          (capture
            ? sameCapture(memo.capture, capture) &&
              (previous?.result || (memo.content === expectedContent(memo) && memo.visibility === visibility))
            : memo.content === expectedContent(memo) && memo.visibility === visibility) &&
          (operation.serverMemoId || Date.parse(memo.createTime) >= operation.startedAt - RECONCILIATION_CLOCK_SKEW_MS),
      );
      if (match) {
        const failedImageDetails = operation.inlineImages
          ? (previous?.failedImageDetails ??
            imagePlan
              .filter((entry) => !match.attachments?.some((attachment) => attachment.name === `attachments/${entry.id}`))
              .map((entry) => ({ url: entry.source, reason: "图片未能转存，已保留原链接" })))
          : undefined;
        const failedImages =
          previous?.failedImages ?? failedImageDetails?.length ?? Math.max(0, images.length - (match.attachments?.length ?? 0));
        const result: Extract<SaveResult, { ok: true }> = {
          ok: true,
          webUrl: memoWebUrl(credentials.instanceUrl, match),
          ...(failedImages ? { failedImages } : {}),
          ...(failedImageDetails?.length ? { failedImageDetails } : {}),
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

  let attempt: AttemptRecord = previous ?? {
    fingerprint,
    startedAt: operation.startedAt,
    ...(operation.inlineImages ? { inlineImages: true } : {}),
  };
  await writeAttempt(attemptKey, attempt);

  let names = attempt.attachmentNames;
  let failed = attempt.failedImages ?? 0;
  let finalContent = attempt.memoContent ?? content;
  if (operation.inlineImages && !names) {
    const archived = await archiveMarkdownImages(
      content,
      imagePlan,
      credentials,
      async (imageEntries) => {
        attempt = { ...attempt, imageEntries: imageEntries.map((entry) => ({ ...entry })) };
        await writeAttempt(attemptKey, attempt);
      },
      () => connectionStillMatches(expected, credentials),
    );
    names = archived.names;
    failed = archived.failures.length;
    finalContent = archived.content;
    attempt = {
      ...attempt,
      attachmentNames: names,
      failedImages: failed,
      failedImageDetails: archived.failures,
      memoContent: finalContent,
    };
    await writeAttempt(attemptKey, attempt);
  } else if (!names) {
    const uploaded = await uploadImages(images, credentials, () => connectionStillMatches(expected, credentials));
    names = uploaded.names;
    failed = uploaded.failed;
    attempt = { ...attempt, attachmentNames: names, failedImages: failed };
    await writeAttempt(attemptKey, attempt);
  }

  if (!(await connectionStillMatches(expected, credentials))) return { ok: false, errorKind: "auth-changed" };
  if (contentMaxBytes !== undefined && new TextEncoder().encode(finalContent).byteLength > contentMaxBytes) {
    return { ok: false, errorKind: "content-too-large", contentMaxBytes };
  }
  attempt = { ...attempt, memoCreationStarted: true };
  await writeAttempt(attemptKey, attempt);
  const result = await createMemoWithAttachments(finalContent, names, credentials, visibility, operation.serverMemoId, capture, tags);
  if (result.ok) {
    const success =
      failed > 0
        ? {
            ...result,
            failedImages: failed,
            ...(attempt.failedImageDetails?.length ? { failedImageDetails: attempt.failedImageDetails } : {}),
          }
        : result;
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

export async function saveSelectionClip(
  clip: SelectionClip,
  title: string,
  url: string,
  credentials: MemosCredentials,
  template: string | null,
): Promise<SaveResult> {
  // Older content scripts and the image context menu send media separately; preserve it inline too.
  const inlineSources = new Set(markdownImageUrls(clip.markdown));
  const missingImages = [...new Set(clip.images)].filter((source) => !inlineSources.has(source));
  const body = [
    clip.markdown,
    ...missingImages.map((source) => `![](<${source.replace(/[<>\s\\]/g, (character) => encodeURIComponent(character))}>)`),
  ]
    .filter(Boolean)
    .join("\n\n");
  if (!body.trim()) return { ok: false, errorKind: "bad-response" };
  const content = composeMemoContent({
    bodyMarkdown: toQuotedMarkdown(body),
    title,
    url,
    description: clip.description,
    template,
  });
  // Context-menu saves predate the popup's durable save operation; keep their one-shot behavior.
  const plan = await imageArchivePlan(content, crypto.randomUUID());
  const archived = await archiveMarkdownImages(
    content,
    plan,
    credentials,
    async () => {},
    async () => true,
  );
  const result = await createMemoWithAttachments(archived.content, archived.names, credentials, "PRIVATE");
  return result.ok && archived.failures.length
    ? { ...result, failedImages: archived.failures.length, failedImageDetails: archived.failures }
    : result;
}

async function createMemoWithAttachments(
  content: string,
  attachmentNames: string[],
  credentials: MemosCredentials,
  visibility: Visibility,
  memoId?: string,
  capture?: CaptureData,
  tags?: string[],
): Promise<SaveResult> {
  try {
    const memo = await createMemo(credentials, {
      content,
      visibility,
      ...(capture ? { capture } : {}),
      ...(tags !== undefined ? { tags, explicitTags: true } : {}),
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
