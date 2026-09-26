import { useCallback, useEffect, useRef, useState } from "react";
import browser from "webextension-polyfill";
import { parseCaptureData } from "@/lib/capture-data";
import { composeCaptureMemo, formatCapturedPosts, utf8Bytes } from "@/lib/capture-format";
import type { CaptureData, CaptureKind, ClipSaveStatus } from "@/lib/clip-records";
import type { ConnectionSource } from "@/lib/connection-config";
import { captureSourceKey as draftPageUrl, type EditorSource, findEditorSource } from "@/lib/editor-page";
import { composeMemoContent } from "@/lib/format";
import { estimatedArchivedBytes, markdownImageUrls } from "@/lib/markdown-images";
import type { Visibility } from "@/lib/memos-client";
import type { SaveResult } from "@/lib/messages";
import { sendBackgroundRequest } from "@/lib/runtime-client";
import { LAST_VISIBILITY_KEY, writeLastVisibility } from "@/lib/visibility";
import { captureXPage, type XCaptureResult } from "@/lib/x-capture";
import { captureActivePage } from "./page-capture";

type SaveExpectation = { source: ConnectionSource; connectionId: string; instanceUrl: string };
type SaveOperation = { requestId: string; startedAt: number; content?: string; legacyTags?: boolean; inlineImages?: boolean };
type Tab = { id?: number; title?: string; url?: string };
export type Draft = {
  capture: CaptureData;
  title: string;
  original: string;
  images: string[];
  imageLayout?: "inline";
  tags: string[];
  warnings: string[];
  confirmed: boolean;
  visibility: Visibility;
  operation: SaveOperation | null;
};

const STORAGE_ERROR = "草稿未能写入本机存储，请保留当前窗口并重试；未落盘的输入在关闭窗口后可能丢失。";
const AMBIGUOUS_ERRORS = new Set(["timeout", "unreachable", "cors", "bad-response", "extension-error"]);
const validVisibility = (value: unknown): value is Visibility => ["PRIVATE", "PROTECTED", "PUBLIC"].includes(String(value));
const defaultTags = (mode: CaptureKind) => [mode === "PICK_UP" ? "pick up" : "star"];

/** Older drafts only kept a separate image list. Preserve those images without replacing edited text. */
function upgradeDraftImages(draft: Draft): Draft {
  if (draft.imageLayout === "inline") return draft;
  const existing = new Set(markdownImageUrls(composeCaptureMemo(draft.capture, draft.original)));
  const missing = [...new Set(draft.images)].filter((source) => !existing.has(source));
  return {
    ...draft,
    imageLayout: "inline",
    original: [
      draft.original,
      ...missing.map((source) => `![](<${source.replace(/[<>\s\\]/g, (character) => encodeURIComponent(character))}>)`),
    ].join("\n\n"),
    warnings: missing.length ? [...draft.warnings, "旧草稿的图片已补到原内容末尾；重新提取可恢复图文位置。"] : draft.warnings,
  };
}

async function bounded<T>(promise: Promise<T>, message: string, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function restoreDraft(value: unknown, mode: CaptureKind, pageUrl: string): Draft | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const capture = parseCaptureData(raw.capture);
  if (!capture || capture.kind !== mode || draftPageUrl(capture.sourceUrl) !== pageUrl || raw.schemaVersion !== 1) return null;
  if (typeof raw.title !== "string" || typeof raw.original !== "string" || typeof raw.confirmed !== "boolean") return null;
  if (!validVisibility(raw.visibility)) return null;
  if (!Array.isArray(raw.images) || !raw.images.every((image) => typeof image === "string")) return null;
  if (!Array.isArray(raw.warnings) || !raw.warnings.every((warning) => typeof warning === "string")) return null;
  if (raw.tags !== undefined && (!Array.isArray(raw.tags) || !raw.tags.every((tag) => typeof tag === "string"))) return null;
  let operation: SaveOperation | null = null;
  if (raw.operation !== null && raw.operation !== undefined) {
    const saved = raw.operation as Partial<SaveOperation>;
    if (typeof saved.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(saved.requestId)) return null;
    if (typeof saved.startedAt !== "number" || !Number.isFinite(saved.startedAt) || saved.startedAt <= 0) return null;
    if (saved.content !== undefined && typeof saved.content !== "string") return null;
    if (saved.legacyTags !== undefined && typeof saved.legacyTags !== "boolean") return null;
    if (saved.inlineImages !== undefined && typeof saved.inlineImages !== "boolean") return null;
    operation = {
      requestId: saved.requestId,
      startedAt: saved.startedAt,
      content: saved.content ?? composeCaptureMemo(capture, raw.original, raw.tags === undefined, false),
      legacyTags: saved.legacyTags ?? raw.tags === undefined,
      inlineImages: saved.inlineImages ?? false,
    };
  }
  const draft: Draft = {
    capture,
    title: raw.title,
    original: raw.original,
    images: raw.images,
    ...(raw.imageLayout === "inline" ? { imageLayout: "inline" } : {}),
    tags: (raw.tags as string[] | undefined) ?? defaultTags(mode),
    warnings: raw.warnings,
    confirmed: raw.confirmed,
    visibility: raw.visibility,
    operation,
  };
  return operation ? draft : upgradeDraftImages(draft);
}

/** Manual capture with account-scoped drafts and durable, retryable save operations. */
export function useClipper(expectation: SaveExpectation | null, template: string | null, source?: EditorSource | null) {
  const [tab, setTab] = useState<Tab | null>(null);
  const [tabReady, setTabReady] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<{ supported: boolean; contentMaxBytes: number } | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [savedClip, setSavedClip] = useState<ClipSaveStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [capabilityRetry, setCapabilityRetry] = useState(0);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [tagsRetry, setTagsRetry] = useState(0);
  const accountKey = expectation
    ? JSON.stringify([expectation.source, expectation.connectionId, expectation.instanceUrl.replace(/\/+$/, "")])
    : "";
  // A temporarily unavailable session must not erase the draft shown in the blocked view.
  const lastAccountKey = useRef(accountKey);
  if (accountKey) lastAccountKey.current = accountKey;
  const draftAccountKey = accountKey || lastAccountKey.current;
  const pageUrl = draftPageUrl(tab?.url ?? "");
  const scope = draftAccountKey && pageUrl ? `captureDraftV1:${encodeURIComponent(draftAccountKey)}:${encodeURIComponent(pageUrl)}` : "";
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const accountRef = useRef(accountKey);
  accountRef.current = accountKey;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const draftRef = useRef<Draft | null>(null);
  const modes = useRef<Partial<Record<CaptureKind, Draft>>>({});
  const busyRef = useRef(false);
  const extractingRef = useRef(false);
  const readyRef = useRef(false);
  const readyScope = useRef("");
  const revision = useRef(0);
  const extraction = useRef(0);
  const statusRevision = useRef(0);
  const defaultVisibility = useRef<Visibility>("PRIVATE");
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    const metadata: Promise<Tab | null> =
      source === undefined
        ? browser.tabs.query({ active: true, currentWindow: true }).then(([current]) => current ?? null)
        : Promise.resolve(source);
    void bounded(metadata, "读取标签页超时", 750)
      .then((current) => {
        if (active) setTab(current ?? null);
      })
      .catch(() => {
        if (active) setNotice("无法读取当前标签页，请重新打开扩展。");
      })
      .finally(() => {
        if (active) setTabReady(true);
      });
    const onUpdated = (id: number, change: { url?: string }, updated: Tab) => {
      if (source !== undefined) return;
      if (id === tabRef.current?.id && change.url) setTab({ ...tabRef.current, ...updated, url: change.url });
    };
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => {
      active = false;
      mounted.current = false;
      extraction.current++;
      browser.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [source]);

  const persist = useCallback((next: Draft, targetScope: string): Promise<boolean> => {
    const write = writes.current
      .catch(() => {})
      .then(() =>
        browser.storage.local.set({
          [`${targetScope}:${next.capture.kind}`]: { schemaVersion: 1, ...next },
          [`${targetScope}:active`]: next.capture.kind,
        }),
      );
    writes.current = write;
    return write.then(
      () => {
        if (mounted.current && scopeRef.current === targetScope) setStorageError(null);
        return true;
      },
      () => {
        if (mounted.current && scopeRef.current === targetScope) setStorageError(STORAGE_ERROR);
        return false;
      },
    );
  }, []);

  const applyDraft = useCallback((next: Draft) => {
    draftRef.current = next;
    modes.current[next.capture.kind] = next;
    setDraft(next);
  }, []);

  useEffect(() => {
    let active = true;
    readyRef.current = false;
    readyScope.current = "";
    draftRef.current = null;
    modes.current = {};
    busyRef.current = false;
    extractingRef.current = false;
    defaultVisibility.current = "PRIVATE";
    extraction.current++;
    setReady(false);
    setDraft(null);
    setBusy(false);
    setExtracting(false);
    setStorageError(null);
    setNotice(null);
    if (!scope) {
      readyRef.current = tabReady;
      setReady(tabReady);
      return;
    }
    void writes.current
      .catch(() => {})
      .then(() => browser.storage.local.get([`${scope}:STAR`, `${scope}:PICK_UP`, `${scope}:active`, LAST_VISIBILITY_KEY]))
      .then((stored) => {
        if (!active || scopeRef.current !== scope) return;
        defaultVisibility.current = validVisibility(stored[LAST_VISIBILITY_KEY]) ? stored[LAST_VISIBILITY_KEY] : "PRIVATE";
        for (const mode of ["STAR", "PICK_UP"] as const) {
          const restored = restoreDraft(stored[`${scope}:${mode}`], mode, pageUrl);
          if (restored) modes.current[mode] = restored;
        }
        const activeMode = stored[`${scope}:active`] === "PICK_UP" ? "PICK_UP" : "STAR";
        const restored = modes.current[activeMode] ?? modes.current.STAR ?? modes.current.PICK_UP;
        if (restored) {
          applyDraft(restored);
          setNotice(restored.operation ? "上次保存结果尚未确认，请先重试保存以确认结果。" : "已恢复当前页面的本地草稿。");
        }
      })
      .catch(() => {
        if (active && scopeRef.current === scope) setStorageError("无法恢复本地草稿；当前输入仍可使用，保存前将再次尝试写入存储。");
      })
      .finally(() => {
        if (active && scopeRef.current === scope) {
          readyRef.current = true;
          readyScope.current = scope;
          setReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, [scope, tabReady, applyDraft]);

  useEffect(() => {
    let active = true;
    setCapabilities(null);
    setCapabilityError(null);
    if (!expectation) return;
    void sendBackgroundRequest({
      type: "GET_CAPTURE_CAPABILITIES",
      expectedSource: expectation.source,
      expectedConnectionId: expectation.connectionId,
      expectedInstanceUrl: expectation.instanceUrl,
    })
      .then((result) => {
        if (!active || accountRef.current !== accountKey) return;
        if (!result?.ok || typeof result.supported !== "boolean" || !Number.isFinite(result.contentMaxBytes)) {
          throw new Error("capabilities unavailable");
        }
        setCapabilities({ supported: result.supported, contentMaxBytes: result.contentMaxBytes });
      })
      .catch(() => {
        if (active && accountRef.current === accountKey) setCapabilityError("无法确认服务器同步能力与正文上限，请重试检测。");
      });
    return () => {
      active = false;
    };
  }, [accountKey, capabilityRetry]);

  useEffect(() => {
    let active = true;
    const request = ++statusRevision.current;
    setSavedClip(null);
    setStatusError(null);
    if (!expectation || !scope || !ready) return;
    void sendBackgroundRequest({
      type: "GET_CLIP_STATUS",
      sourceUrl: draft?.capture.sourceUrl ?? pageUrl,
      kind: draft?.capture.kind ?? "STAR",
      expectedSource: expectation.source,
      expectedConnectionId: expectation.connectionId,
      expectedInstanceUrl: expectation.instanceUrl,
    })
      .then((record) => {
        if (record !== null && (!record || typeof record.memoUrl !== "string" || !Number.isFinite(record.savedAt))) {
          throw new Error("invalid clip status");
        }
        if (active && scopeRef.current === scope && request === statusRevision.current) setSavedClip(record ?? null);
      })
      .catch(() => {
        if (active && scopeRef.current === scope && request === statusRevision.current)
          setStatusError("无法读取服务器保存记录，当前无法判断此页面是否已保存。");
      });
    return () => {
      active = false;
    };
  }, [scope, accountKey, ready, draft?.capture.kind, draft?.capture.sourceUrl]);

  useEffect(() => {
    let active = true;
    setTagSuggestions([]);
    setTagsError(null);
    setTagsLoading(false);
    if (!expectation || !draft || !capabilities?.supported) return;
    setTagsLoading(true);
    void sendBackgroundRequest({
      type: "GET_MEMO_TAGS",
      expectedSource: expectation.source,
      expectedConnectionId: expectation.connectionId,
      expectedInstanceUrl: expectation.instanceUrl,
    })
      .then((result) => {
        if (!active || accountRef.current !== accountKey) return;
        if (!result?.ok || !Array.isArray(result.tags) || !result.tags.every((tag) => typeof tag === "string")) {
          throw new Error("tags unavailable");
        }
        setTagSuggestions(result.tags);
      })
      .catch(() => {
        if (active && accountRef.current === accountKey) setTagsError("已有标签读取失败");
      })
      .finally(() => {
        if (active && accountRef.current === accountKey) setTagsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [accountKey, !!draft, capabilities?.supported, tagsRetry]);

  const update = useCallback(
    (change: Partial<Draft>, fields?: Partial<CaptureData>) => {
      const current = draftRef.current;
      if (!expectation || !current || busyRef.current || !scope || scopeRef.current !== scope || readyScope.current !== scope) return;
      if (current.operation) {
        setNotice("上次保存结果尚未确认，请先重试保存，再继续修改这份草稿。");
        return;
      }
      revision.current++;
      const next = { ...current, ...change, capture: { ...current.capture, ...fields }, operation: null };
      applyDraft(next);
      void persist(next, scope);
    },
    [expectation, scope, applyDraft, persist],
  );

  const start = useCallback(
    async (mode: CaptureKind, refresh = false) => {
      if (!expectation || !scope || !readyRef.current || busyRef.current || scopeRef.current !== scope || readyScope.current !== scope)
        return;
      const existing = modes.current[mode];
      if (existing && !refresh) {
        extraction.current++;
        extractingRef.current = false;
        setExtracting(false);
        applyDraft(existing);
        setNotice(existing.operation ? "上次保存结果尚未确认，请先重试保存以确认结果。" : null);
        void persist(existing, scope);
        return;
      }
      if (existing?.operation) {
        setNotice("请先重试确认上次保存结果，再重新提取正文。");
        return;
      }
      const request = ++extraction.current;
      const edit = revision.current;
      extractingRef.current = true;
      setExtracting(true);
      setNotice(null);
      try {
        let next: Draft;
        const targetTab = source ? await bounded(findEditorSource(source), "读取原网页超时，请重试。", 750) : tab;
        const isXDetail = /^https:\/\/(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)\/\w+\/status\/\d+(?:[/?#]|$)/i.test(tab?.url ?? "");
        if (mode === "STAR" && !isXDetail) {
          const captured = await captureActivePage(source ? targetTab?.id : undefined);
          if (source && !captured.url) throw new Error("原网页已关闭或无法读取，当前草稿已保留。请重新打开原网页后点击扩展图标。");
          if (!/^https?:\/\//i.test(captured.url)) throw new Error("当前页面不是可保存的网页，请打开普通网页后再使用 Star。");
          if (draftPageUrl(captured.url) !== pageUrl)
            throw new Error("原网页已切换，请回到原页面后重新提取，或在新页面点击扩展图标。当前草稿已保留。");
          const original = composeMemoContent({
            bodyMarkdown: captured.selectionMarkdown || captured.articleMarkdown,
            title: captured.title,
            url: captured.url,
            description: captured.description,
            template,
          });
          next = {
            capture: {
              kind: "STAR",
              platform: "WEB",
              sourceUrl: captured.url,
              sourceId: "",
              comment: existing?.capture.comment ?? "",
              context: existing?.capture.context ?? "",
              posts: [],
            },
            title: captured.title,
            original,
            images: captured.images,
            imageLayout: "inline",
            tags: existing?.tags ?? defaultTags(mode),
            warnings: captured.fallbackReason ? ["页面正文未能完整提取，请核对原内容；必要时选择正文后重新提取。"] : [],
            confirmed: true,
            visibility: existing?.visibility ?? defaultVisibility.current,
            operation: null,
          };
        } else {
          if (!isXDetail || targetTab?.id === undefined) throw new Error("请打开你自己的 X 发帖、回复或引用帖详情页，再使用 Pick up。");
          const [injected] = await bounded(
            browser.scripting.executeScript({ target: { tabId: targetTab.id }, func: captureXPage, args: [mode] }),
            "X 页面提取超时，请展开帖子后重试。",
            2_000,
          );
          const result = injected?.result as XCaptureResult | undefined;
          if (!result?.capture) throw new Error(result?.error ?? "未能提取 X 帖子，请展开对话后重试。");
          if (result.capture.kind !== mode) throw new Error("提取结果与当前模式不一致，请重新提取。");
          if (mode === "PICK_UP" && result.isOwnPost === false)
            throw new Error("当前帖子不属于已登录的 X 账号，请打开你自己的发帖、回复或引用帖。");
          if (draftPageUrl(result.capture.sourceUrl) !== pageUrl) throw new Error("页面已切换，请重新打开扩展后提取。");
          next = {
            capture: {
              ...result.capture,
              comment: mode === "STAR" ? (existing?.capture.comment ?? "") : result.capture.comment,
              context: existing?.capture.context ?? "",
            },
            title: result.title,
            original:
              mode === "STAR"
                ? `${formatCapturedPosts(result.capture)}\n\n[来源](${result.capture.sourceUrl})`
                : formatCapturedPosts(result.capture),
            images: result.images,
            imageLayout: "inline",
            tags: existing?.tags ?? defaultTags(mode),
            warnings: result.warnings,
            confirmed: mode === "STAR" || result.isOwnPost === true || existing?.confirmed === true,
            visibility: existing?.visibility ?? defaultVisibility.current,
            operation: null,
          };
        }
        if (!mounted.current || scopeRef.current !== scope || accountRef.current !== accountKey || request !== extraction.current) return;
        if (edit !== revision.current) {
          setNotice("提取期间草稿已修改，已保留你的输入；需要时可重新提取。");
          return;
        }
        applyDraft(next);
        await persist(next, scope);
      } catch (error) {
        if (mounted.current && scopeRef.current === scope && request === extraction.current)
          setNotice(error instanceof Error ? error.message : "提取失败，请重试。");
      } finally {
        if (mounted.current && scopeRef.current === scope && request === extraction.current) {
          extractingRef.current = false;
          setExtracting(false);
        }
      }
    },
    [expectation, accountKey, scope, pageUrl, tab, template, source, applyDraft, persist],
  );

  const content = draft ? (draft.operation?.content ?? composeCaptureMemo(draft.capture, draft.original)) : "";
  const contentBytes = draft?.operation && !draft.operation.inlineImages ? utf8Bytes(content) : estimatedArchivedBytes(content);
  const overLimit = !!capabilities && capabilities.contentMaxBytes > 0 && contentBytes > capabilities.contentMaxBytes;

  const save = useCallback(async (): Promise<SaveResult> => {
    if (!expectation) return { ok: false, errorKind: "not-configured" };
    const current = draftRef.current;
    if (!current || !scope || scopeRef.current !== scope || readyScope.current !== scope || busyRef.current || extractingRef.current)
      return { ok: false, errorKind: "invalid-content", message: "请先提取内容，或等待当前保存完成。" };
    if (!capabilities?.supported) return { ok: false, errorKind: "capture-unsupported", message: "请先确认服务器支持同步记录。" };
    if (current.capture.kind === "PICK_UP" && !current.confirmed)
      return { ok: false, errorKind: "invalid-content", message: "请先确认这条评论属于你。" };
    const memo = current.operation?.content ?? composeCaptureMemo(current.capture, current.original);
    const saveBytes = current.operation && !current.operation.inlineImages ? utf8Bytes(memo) : estimatedArchivedBytes(memo);
    if (capabilities.contentMaxBytes > 0 && saveBytes > capabilities.contentMaxBytes)
      return { ok: false, errorKind: "content-too-large", contentMaxBytes: capabilities.contentMaxBytes };
    const operation: SaveOperation = current.operation ?? {
      requestId: globalThis.crypto?.randomUUID?.() ?? `clip_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      startedAt: Date.now(),
      content: memo,
      inlineImages: true,
    };
    const pending = { ...current, operation };
    busyRef.current = true;
    setBusy(true);
    applyDraft(pending);
    try {
      if (!(await persist(pending, scope))) {
        if (mounted.current && scopeRef.current === scope) applyDraft(current);
        return { ok: false, errorKind: "storage-error" };
      }
      if (!mounted.current || scopeRef.current !== scope || accountRef.current !== accountKey)
        return { ok: false, errorKind: "auth-changed" };
      let result: SaveResult;
      try {
        result = await sendBackgroundRequest({
          type: "SAVE_MEMO",
          content: memo,
          visibility: current.visibility,
          expectedSource: expectation.source,
          expectedConnectionId: expectation.connectionId,
          expectedInstanceUrl: expectation.instanceUrl,
          saveRequestId: operation.requestId,
          saveStartedAt: operation.startedAt,
          saveIsRetry: Boolean(current.operation),
          images: operation.inlineImages ? [] : current.images,
          inlineImages: operation.inlineImages,
          ...(operation.legacyTags ? {} : { tags: current.tags }),
          clip: {
            sourceUrl: current.capture.sourceUrl,
            sourceTitle: current.title,
            imageCount: Math.min(current.images.length, 100),
            capture: current.capture,
          },
        });
        if (!result || typeof result.ok !== "boolean") result = { ok: false, errorKind: "extension-error" };
      } catch {
        result = { ok: false, errorKind: "extension-error" };
      }
      if (!mounted.current || scopeRef.current !== scope || accountRef.current !== accountKey) return result;
      if (result.ok || !AMBIGUOUS_ERRORS.has(result.errorKind)) {
        const finished = upgradeDraftImages({ ...pending, operation: null });
        applyDraft(finished);
        await persist(finished, scope);
      }
      if (result.ok) {
        statusRevision.current++;
        setSavedClip({ memoUrl: result.webUrl, savedAt: Date.now() });
        setStatusError(null);
        setNotice("已保存到服务器，本地草稿仍保留，方便继续补充。");
        await writeLastVisibility(current.visibility).catch(() => {});
      } else if (AMBIGUOUS_ERRORS.has(result.errorKind)) {
        setNotice("保存结果尚未确认，请重试保存；将使用同一请求避免重复创建。");
      } else if (result.errorKind === "not-found") {
        setSavedClip(null);
        setNotice("服务器未找到上次记录，可能未送达或已被删除。请先检查历史；若确实需要新建，请再次点击保存。");
      }
      return result;
    } finally {
      if (mounted.current && scopeRef.current === scope) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [expectation, accountKey, capabilities, scope, applyDraft, persist]);

  return {
    draft,
    ready,
    busy,
    extracting,
    notice,
    storageError,
    capabilities,
    capabilityError,
    savedClip,
    statusError,
    content,
    contentBytes,
    overLimit,
    tab,
    start,
    update,
    save,
    awaitingConfirmation: !!draft?.operation && !busy,
    retryCapabilities: () => setCapabilityRetry((value) => value + 1),
    tagSuggestions,
    tagsLoading,
    tagsError,
    retryTags: () => setTagsRetry((value) => value + 1),
  };
}
