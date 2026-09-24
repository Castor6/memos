import { beforeEach, describe, expect, it, vi } from "vitest";
import { SAVE_ATTEMPTS_KEY } from "@/background/memo-save";
import { CONNECTION_CONFIG_KEY } from "@/lib/connection-config";
import { LOCALE_PREFERENCE_KEY } from "@/lib/i18n";
import { VERSION_CACHE_KEY } from "@/lib/instance-version";
import { POPUP_STATE_KEY } from "@/lib/popup-state";
import { CLIP_TEMPLATE_KEY } from "@/lib/template-settings";
import { browserMock, seedStorage, setBrowserLocale } from "@/test/browser-mock";
import { jsonResponse, testCreds } from "@/test/fixtures";
import germanMessages from "../../public/_locales/de/messages.json" with { type: "json" };

/** Seed the per-device version cache so the gate reads it without a live fetch. */
const seedVersion = (version: string) => seedStorage({ [VERSION_CACHE_KEY]: { instanceUrl: testCreds.instanceUrl, version } });

// Background reads OAuth userinfo; this fixture keeps the existing destination-focused cases terse.
type MockUser = {
  id: string;
  unsafeMetadata: Record<string, unknown>;
  reload?: () => Promise<MockUser>;
  fullName?: string;
  username?: string;
  imageUrl?: string;
  primaryEmailAddress?: { emailAddress: string };
};
let mockUser: MockUser | null = null;
const oauthMocks = vi.hoisted(() => ({
  beginOAuthSignIn: vi.fn(async () => undefined),
  clearOAuthSession: vi.fn(async () => undefined),
  getOAuthUser: vi.fn(),
  OAuthUnavailableError: class OAuthUnavailableError extends Error {
    constructor() {
      super("OAuth unavailable");
      this.name = "OAuthUnavailableError";
    }
  },
}));
vi.mock("@/auth/oauth-session", () => ({
  beginOAuthSignIn: oauthMocks.beginOAuthSignIn,
  clearOAuthSession: oauthMocks.clearOAuthSession,
  getOAuthUser: oauthMocks.getOAuthUser,
  OAuthUnavailableError: oauthMocks.OAuthUnavailableError,
  toOAuthIdentity: (user: { id: string; displayName: string; imageUrl?: string }) => ({
    id: user.id,
    displayName: user.displayName,
    ...(user.imageUrl ? { imageUrl: user.imageUrl } : {}),
  }),
}));

const memos = (extra: Record<string, unknown> = {}) => ({
  memos: { instanceUrl: testCreds.instanceUrl, accessToken: testCreds.accessToken, ...extra },
});
const ready = () => {
  mockUser = { id: "user_123", unsafeMetadata: memos(), fullName: "Steven Li" };
  seedVersion("0.29.1");
};
const expected = {
  expectedSource: "usememos" as const,
  expectedConnectionId: "user_123",
  expectedInstanceUrl: testCreds.instanceUrl,
};
const popupSender = { id: "test-id", url: "chrome-extension://test-id/src/popup/index.html" };
const optionsSender = { id: "test-id", url: "chrome-extension://test-id/src/options/index.html" };
const emitRuntime = (message: unknown, sender = popupSender) => browserMock.runtime.onMessage.emitFirst(message, sender);

const seedDirectConnection = () => {
  seedStorage({
    [CONNECTION_CONFIG_KEY]: {
      schemaVersion: 1,
      activeSource: "direct",
      direct: {
        connectionId: "direct_123",
        instanceUrl: testCreds.instanceUrl,
        accessToken: testCreds.accessToken,
        user: { name: "users/steven", displayName: "Steven" },
        verifiedAt: Date.now(),
      },
    },
    [VERSION_CACHE_KEY]: { instanceUrl: testCreds.instanceUrl, version: "0.29.1" },
  });
};

// Import once: the module registers its listeners on the shared browser mock at load.
beforeEach(async () => {
  oauthMocks.beginOAuthSignIn.mockClear();
  oauthMocks.clearOAuthSession.mockClear();
  oauthMocks.getOAuthUser.mockImplementation(async () => {
    const current = mockUser?.reload ? await mockUser.reload() : mockUser;
    if (!current) return null;
    return {
      id: current.id,
      displayName: current.fullName ?? current.username ?? current.primaryEmailAddress?.emailAddress ?? "Account",
      ...(current.imageUrl ? { imageUrl: current.imageUrl } : {}),
      unsafeMetadata: current.unsafeMetadata,
    };
  });
  await import("@/background");
});

describe("background — storage isolation", () => {
  it("restricts storage.local to trusted extension contexts", () => {
    expect(browserMock.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
  });
});

describe("background — editor launcher", () => {
  it("opens a tab from the toolbar without extracting or saving", async () => {
    await browserMock.action.onClicked.emit({ id: 7, url: "https://example.com/post" });
    expect(browserMock.tabs.create).toHaveBeenCalledWith({
      url: "chrome-extension://test-id/src/popup/index.html?sourceTab=7&sourceUrl=https%3A%2F%2Fexample.com%2Fpost",
      openerTabId: 7,
    });
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });
});

describe("background — SAVE_MEMO message", () => {
  beforeEach(ready);

  const starCapture = {
    kind: "STAR",
    platform: "WEB",
    sourceUrl: "https://example.org/",
    sourceId: "",
    comment: "My thought",
    context: "A reason",
    posts: [],
  };
  const captureRequest = (id: string, images: string[] = []) => ({
    type: "SAVE_MEMO",
    content: "body",
    visibility: "PRIVATE",
    ...expected,
    saveRequestId: id,
    saveStartedAt: Date.now(),
    images,
    clip: { sourceUrl: starCapture.sourceUrl, sourceTitle: "Title", imageCount: images.length, capture: starCapture },
  });

  function inlineArchiveServer(options: { loseMemoResponse?: boolean; loseSecondUpload?: boolean; failDownload?: boolean } = {}) {
    const attachments = new Map<string, { name: string; filename: string }>();
    const attachmentPosts: string[] = [];
    const downloads: string[] = [];
    let saved: Record<string, unknown> | null = null;
    let memoPosts = 0;
    let attachmentReadsBlocked = !!options.loseSecondUpload;
    const timeout = () => Promise.reject(Object.assign(new Error("response lost"), { name: "TimeoutError" }));
    const fetchMock = vi.fn((value: unknown, init?: RequestInit) => {
      const url = new URL(String(value));
      if (url.pathname.endsWith("/instance/profile")) return Promise.resolve(jsonResponse({ version: "dev", webClipperSupported: true }));
      if (url.pathname.endsWith("/auth/me")) return Promise.resolve(jsonResponse({ user: { name: "users/steven" } }));
      if (url.hostname === "cdn.example.org") {
        downloads.push(url.href);
        return Promise.resolve(
          options.failDownload
            ? new Response(null, { status: 404 })
            : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
        );
      }
      if (url.pathname.endsWith("/attachments") && init?.method === "POST") {
        const id = url.searchParams.get("attachmentId")!;
        const body = JSON.parse(String(init.body));
        const attachment = { name: `attachments/${id}`, filename: body.filename };
        attachmentPosts.push(id);
        attachments.set(id, attachment);
        if (options.loseSecondUpload && attachmentPosts.length === 2) return timeout();
        return Promise.resolve(jsonResponse(attachment));
      }
      if (url.pathname.includes("/attachments/")) {
        if (attachmentReadsBlocked) return timeout();
        const attachment = attachments.get(url.pathname.split("/").pop()!);
        return Promise.resolve(attachment ? jsonResponse(attachment) : jsonResponse({}, 404));
      }
      if (url.pathname.endsWith("/memos") && init?.method === "POST") {
        memoPosts += 1;
        const body = JSON.parse(String(init.body));
        saved = {
          ...body,
          name: `memos/${url.searchParams.get("memoId")}`,
          creator: "users/steven",
          createTime: new Date().toISOString(),
          attachments: (body.attachments ?? []).map(({ name }: { name: string }) => attachments.get(name.split("/").pop()!)),
        };
        return options.loseMemoResponse ? timeout() : Promise.resolve(jsonResponse(saved));
      }
      if (url.pathname.endsWith("/memos")) return Promise.resolve(jsonResponse({ memos: saved ? [saved] : [] }));
      return Promise.resolve(saved ? jsonResponse(saved) : jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    return {
      attachments,
      attachmentPosts,
      downloads,
      saved: () => saved,
      memoPosts: () => memoPosts,
      allowAttachmentReads: () => {
        attachmentReadsBlocked = false;
      },
    };
  }

  it("archives inline images in place once per source and ignores removed legacy image candidates", async () => {
    const server = inlineArchiveServer();
    const image = "https://cdn.example.org/image.png";
    const request = {
      ...captureRequest("inline_positions", ["https://cdn.example.org/deleted.png"]),
      inlineImages: true,
      content: `Before\n\n![first](${image})\n\nBetween\n\n![second](<${image}>)\n\nAfter`,
    };
    expect(await emitRuntime(request)).toMatchObject({ ok: true });
    expect(server.downloads).toEqual([image]);
    expect(server.attachmentPosts).toHaveLength(1);
    const attachment = [...server.attachments.values()][0]!;
    const path = `/file/${attachment.name}/${attachment.filename}`;
    expect(server.saved()?.content).toBe(`Before\n\n![first](${path})\n\nBetween\n\n![second](<${path}>)\n\nAfter`);
    vi.unstubAllGlobals();
  });

  it("keeps failed inline image links and reports the specific image after saving text", async () => {
    const server = inlineArchiveServer({ failDownload: true });
    const image = "https://cdn.example.org/missing.png";
    const request = { ...captureRequest("inline_failed"), inlineImages: true, content: `Text\n\n![missing](${image})` };
    expect(await emitRuntime(request)).toMatchObject({
      ok: true,
      failedImages: 1,
      failedImageDetails: [{ url: image, reason: expect.any(String) }],
    });
    expect(server.saved()?.content).toBe(request.content);
    expect(server.attachmentPosts).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it.each([false, true])("reconciles rewritten inline content after a lost memo response (cache cleared: %s)", async (clearCache) => {
    const server = inlineArchiveServer({ loseMemoResponse: true });
    const request = {
      ...captureRequest(clearCache ? "inline_no_cache" : "inline_retry"),
      inlineImages: true,
      content: "Text\n\n![photo](https://cdn.example.org/image.png)",
    };
    expect(await emitRuntime(request)).toEqual({ ok: false, errorKind: "timeout" });
    if (clearCache) await browserMock.storage.local.remove(SAVE_ATTEMPTS_KEY);
    expect(await emitRuntime({ ...request, saveIsRetry: true })).toMatchObject({ ok: true });
    expect(server.attachmentPosts).toHaveLength(1);
    expect(server.downloads).toHaveLength(1);
    expect(server.memoPosts()).toBe(1);
    expect(server.saved()?.content).toContain("/file/attachments/clip");
    vi.unstubAllGlobals();
  });

  it("resumes an unknown second upload without repeating the first or abandoning an uncreated memo", async () => {
    const server = inlineArchiveServer({ loseSecondUpload: true });
    const request = {
      ...captureRequest("inline_upload_resume"),
      inlineImages: true,
      content: "![first](https://cdn.example.org/first.png)\n\n![second](https://cdn.example.org/second.png)",
    };
    expect(await emitRuntime(request)).toEqual({ ok: false, errorKind: "timeout" });
    expect(server.memoPosts()).toBe(0);
    server.allowAttachmentReads();
    expect(await emitRuntime({ ...request, saveIsRetry: true })).toMatchObject({ ok: true });
    expect(server.attachmentPosts).toHaveLength(2);
    expect(new Set(server.attachmentPosts).size).toBe(2);
    expect(server.downloads).toHaveLength(2);
    expect(server.memoPosts()).toBe(1);
    expect(String(server.saved()?.content).match(/\/file\/attachments\/clip/g)).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it("saves explicit tags and refuses changed tags under the same request id", async () => {
    const fetchMock = vi.fn((value: unknown, init?: RequestInit) => {
      if (String(value).endsWith("/instance/profile")) return Promise.resolve(jsonResponse({ version: "dev", webClipperSupported: true }));
      if (init?.method === "POST") return Promise.resolve(jsonResponse({ name: "memos/tagged_capture" }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = { ...captureRequest("tagged_capture"), tags: ["Star", "中文"] };
    expect(await emitRuntime(request)).toMatchObject({ ok: true });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ tags: ["Star", "中文"], explicitTags: true });
    expect(await emitRuntime({ ...request, tags: ["Star", "changed"] })).toMatchObject({ ok: false });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it.each([
    { confirmed: true, sameSnapshot: true, recovered: true },
    { confirmed: false, sameSnapshot: true, recovered: false },
    { confirmed: true, sameSnapshot: false, recovered: false },
  ])("reconciles later tag edits only for a confirmed matching capture: %j", async ({ confirmed, sameSnapshot, recovered }) => {
    let remote: Record<string, unknown> | null = null;
    const fetchMock = vi.fn((value: unknown, init?: RequestInit) => {
      const url = String(value);
      if (url.endsWith("/instance/profile")) return Promise.resolve(jsonResponse({ version: "dev", webClipperSupported: true }));
      if (url.endsWith("/auth/me")) return Promise.resolve(jsonResponse({ user: { name: "users/steven" } }));
      if (init?.method === "POST") {
        remote = {
          ...JSON.parse(String(init.body)),
          name: "memos/edited_tags_retry",
          creator: "users/steven",
          createTime: new Date().toISOString(),
        };
        return confirmed
          ? Promise.resolve(jsonResponse(remote))
          : Promise.reject(Object.assign(new Error("response lost"), { name: "TimeoutError" }));
      }
      return Promise.resolve(remote ? jsonResponse(remote) : jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = { ...captureRequest("edited_tags_retry"), tags: ["star"] };
    expect(await emitRuntime(request)).toMatchObject(confirmed ? { ok: true } : { ok: false, errorKind: "timeout" });
    remote = {
      ...remote!,
      tags: ["read"],
      capture: sameSnapshot ? starCapture : { ...starCapture, comment: "Different capture" },
    };
    expect(await emitRuntime({ ...request, saveIsRetry: true })).toMatchObject(
      recovered ? { ok: true } : { ok: false, errorKind: "invalid-content" },
    );
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it.each([{ tags: ["Star"] }, { tags: ["Other"] }, { tags: [] }])("reconciles exact tags after local state is lost: %j", async ({
    tags,
  }) => {
    const fetchMock = vi.fn((value: unknown, _init?: RequestInit) => {
      const url = String(value);
      if (url.endsWith("/instance/profile")) return Promise.resolve(jsonResponse({ version: "dev", webClipperSupported: true }));
      if (url.endsWith("/auth/me")) return Promise.resolve(jsonResponse({ user: { name: "users/steven" } }));
      return Promise.resolve(
        jsonResponse({
          name: "memos/tags_reconcile",
          creator: "users/steven",
          createTime: new Date().toISOString(),
          content: "body",
          visibility: "PRIVATE",
          capture: starCapture,
          tags,
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await emitRuntime({ ...captureRequest("tags_reconcile"), tags: ["Star"], saveIsRetry: true })).toMatchObject(
      tags[0] === "Star" ? { ok: true } : { ok: false, errorKind: "invalid-content" },
    );
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("rejects an existing id with changed thoughts instead of accepting a matching source alone", async () => {
    const fetchMock = vi.fn((value: unknown, _init?: RequestInit) => {
      const url = String(value);
      if (url.endsWith("/instance/profile")) return Promise.resolve(jsonResponse({ version: "dev", webClipperSupported: true }));
      if (url.endsWith("/auth/me")) return Promise.resolve(jsonResponse({ user: { name: "users/steven" } }));
      return Promise.resolve(
        jsonResponse({
          name: "memos/snapshot_mismatch",
          creator: "users/steven",
          createTime: new Date().toISOString(),
          content: "body",
          visibility: "PRIVATE",
          capture: { ...starCapture, comment: "Different thought" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await emitRuntime(captureRequest("snapshot_mismatch"))).toMatchObject({ ok: false, errorKind: "invalid-content" });
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== "POST")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("reconciles a partial image save after local retry state is cleared without creating or uploading again", async () => {
    let saved: Record<string, unknown> | null = null;
    let attachmentPosts = 0;
    let memoPosts = 0;
    const fetchMock = vi.fn((value: unknown, init?: RequestInit) => {
      const url = String(value);
      if (url.endsWith("/instance/profile")) return Promise.resolve(jsonResponse({ version: "dev", webClipperSupported: true }));
      if (url.endsWith("/auth/me")) return Promise.resolve(jsonResponse({ user: { name: "users/steven" } }));
      if (url === "https://cdn.example.org/image.png")
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
      if (url.endsWith("/attachments")) {
        attachmentPosts += 1;
        return Promise.reject(Object.assign(new Error("upload response lost"), { name: "TimeoutError" }));
      }
      if (init?.method === "POST") {
        memoPosts += 1;
        saved = {
          ...JSON.parse(String(init.body)),
          name: "memos/forgotten_attempt",
          creator: "users/steven",
          createTime: new Date().toISOString(),
        };
        return Promise.reject(Object.assign(new Error("memo response lost"), { name: "TimeoutError" }));
      }
      return Promise.resolve(saved ? jsonResponse(saved) : jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = captureRequest("forgotten_attempt", ["https://cdn.example.org/image.png"]);
    expect(await emitRuntime(request)).toEqual({ ok: false, errorKind: "timeout" });
    await browserMock.storage.local.remove(SAVE_ATTEMPTS_KEY);
    expect(await emitRuntime({ ...request, saveIsRetry: true })).toEqual({
      ok: true,
      webUrl: "https://memos.example.com/memos/forgotten_attempt",
      failedImages: 1,
    });
    expect(attachmentPosts).toBe(1);
    expect(memoPosts).toBe(1);
    vi.unstubAllGlobals();
  });

  it.each([
    "cleared",
    "expired",
  ])("does not resurrect a deleted memo after an unknown save's local retry state is %s", async (cacheState) => {
    let remote: Record<string, unknown> | null = null;
    let attachmentPosts = 0;
    let memoPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((value: unknown, init?: RequestInit) => {
        const url = String(value);
        if (url.endsWith("/instance/profile")) return Promise.resolve(jsonResponse({ version: "dev", webClipperSupported: true }));
        if (url === "https://cdn.example.org/image.png")
          return Promise.resolve(new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }));
        if (url.endsWith("/attachments")) {
          attachmentPosts += 1;
          return Promise.resolve(jsonResponse({ name: "attachments/image" }));
        }
        if (init?.method === "POST") {
          memoPosts += 1;
          remote = {
            ...JSON.parse(String(init.body)),
            name: "memos/deleted_unknown",
            creator: "users/steven",
            createTime: new Date().toISOString(),
          };
          return Promise.reject(Object.assign(new Error("response lost"), { name: "TimeoutError" }));
        }
        return Promise.resolve(remote ? jsonResponse(remote) : jsonResponse({}, 404));
      }),
    );
    const request = captureRequest("deleted_unknown", ["https://cdn.example.org/image.png"]);
    expect(await emitRuntime({ ...request, saveIsRetry: false })).toEqual({ ok: false, errorKind: "timeout" });
    remote = null;
    if (cacheState === "cleared") await browserMock.storage.local.remove(SAVE_ATTEMPTS_KEY);
    else {
      const stored = await browserMock.storage.local.get(SAVE_ATTEMPTS_KEY);
      const attempts = stored[SAVE_ATTEMPTS_KEY] as Record<string, { updatedAt: number }>;
      for (const attempt of Object.values(attempts)) attempt.updatedAt = Date.now() - 16 * 60_000;
      await browserMock.storage.local.set({ [SAVE_ATTEMPTS_KEY]: attempts });
    }
    expect(await emitRuntime({ ...request, saveIsRetry: true })).toEqual({ ok: false, errorKind: "not-found" });
    expect(memoPosts).toBe(1);
    expect(attachmentPosts).toBe(1);
    vi.unstubAllGlobals();
  });

  it("separates in-flight saves across accounts even when request ids collide", async () => {
    let finishFirst: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((_value: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.content === "first")
        return new Promise<Response>((resolve) => {
          finishFirst = resolve;
        });
      return Promise.resolve(jsonResponse({ name: "memos/second" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = emitRuntime({
      type: "SAVE_MEMO",
      content: "first",
      visibility: "PRIVATE",
      saveRequestId: "shared_request_id",
      ...expected,
    });
    await vi.waitFor(() => expect(finishFirst).toBeDefined());
    mockUser = { id: "second-account", unsafeMetadata: memos({ accessToken: "second-token" }) };
    expect(
      await emitRuntime({
        type: "SAVE_MEMO",
        content: "second",
        visibility: "PRIVATE",
        saveRequestId: "shared_request_id",
        ...expected,
        expectedConnectionId: "second-account",
      }),
    ).toEqual({ ok: true, webUrl: "https://memos.example.com/memos/second" });
    finishFirst?.(jsonResponse({ name: "memos/first" }));
    expect(await first).toEqual({ ok: false, errorKind: "auth-changed" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("checks the account again after image download before writing attachments or a memo", async () => {
    let finishImage: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishImage = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const saving = emitRuntime({
      type: "SAVE_MEMO",
      content: "body",
      visibility: "PRIVATE",
      images: ["https://cdn.example.org/image.png"],
      ...expected,
    });
    await vi.waitFor(() => expect(finishImage).toBeDefined());
    mockUser = { id: "second-account", unsafeMetadata: memos({ accessToken: "second-token" }) };
    finishImage?.(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    expect(await saving).toEqual({ ok: false, errorKind: "auth-changed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("drops a delayed saved-status reply after the active account changes", async () => {
    let finishPage: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((value: unknown) => {
        const url = new URL(String(value));
        if (url.pathname.endsWith("/instance/profile")) return Promise.resolve(jsonResponse({ version: "dev", webClipperSupported: true }));
        if (url.searchParams.get("state") === "NORMAL")
          return new Promise<Response>((resolve) => {
            finishPage = resolve;
          });
        return Promise.resolve(jsonResponse({ memos: [] }));
      }),
    );
    const status = emitRuntime({ type: "GET_CLIP_STATUS", sourceUrl: starCapture.sourceUrl, kind: "STAR", ...expected });
    await vi.waitFor(() => expect(finishPage).toBeDefined());
    mockUser = { id: "second-account", unsafeMetadata: memos() };
    finishPage?.(
      jsonResponse({
        memos: [
          {
            name: "memos/private_old",
            creator: "users/steven",
            content: "body",
            visibility: "PRIVATE",
            createTime: new Date().toISOString(),
            capture: starCapture,
          },
        ],
      }),
    );
    expect(await status).toBeNull();
    vi.unstubAllGlobals();
  });

  it("blocks unsupported sync and UTF-8 overflow before uploads or creates", async () => {
    const capture = { kind: "STAR", platform: "WEB", sourceUrl: "https://example.org/", sourceId: "", comment: "", context: "", posts: [] };
    const request = {
      type: "SAVE_MEMO",
      content: "中文",
      visibility: "PRIVATE",
      images: ["https://cdn.example.org/image.png"],
      ...expected,
      clip: { sourceUrl: capture.sourceUrl, sourceTitle: "Title", imageCount: 1, capture },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ version: "0.29.1" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await emitRuntime(request)).toEqual({ ok: false, errorKind: "capture-unsupported" });
    fetchMock.mockResolvedValue(jsonResponse({ version: "dev", webClipperSupported: true, memoContentMaxBytes: 5 }));
    expect(await emitRuntime(request)).toEqual({ ok: false, errorKind: "content-too-large", contentMaxBytes: 5 });
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith("/instance/profile"))).toBe(true);
    vi.unstubAllGlobals();
  });

  it("allows a custom version only when the server advertises capture support", async () => {
    seedStorage({ [VERSION_CACHE_KEY]: undefined });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ version: "dev", webClipperSupported: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await emitRuntime({ type: "GET_POPUP_STATE" })).toMatchObject({ status: "ready", version: "dev" });
    expect(await emitRuntime({ type: "GET_POPUP_STATE" })).toMatchObject({ status: "ready", version: "dev" });
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("does not recreate a saved memo deleted on the server when an old save is retried", async () => {
    const capture = { kind: "STAR", platform: "WEB", sourceUrl: "https://example.org/", sourceId: "", comment: "", context: "", posts: [] };
    const request = {
      type: "SAVE_MEMO",
      content: "body",
      visibility: "PRIVATE",
      ...expected,
      saveRequestId: "saved_then_deleted",
      saveStartedAt: Date.now(),
      clip: { sourceUrl: capture.sourceUrl, sourceTitle: "Title", imageCount: 0, capture },
    };
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((value: unknown, init?: RequestInit) => {
        const url = String(value);
        if (url.endsWith("/instance/profile"))
          return Promise.resolve(jsonResponse({ version: "dev", webClipperSupported: true, memoContentMaxBytes: 8192 }));
        if (url.endsWith("/auth/me")) return Promise.resolve(jsonResponse({ user: { name: "users/steven" } }));
        if (init?.method === "POST") {
          posts += 1;
          return Promise.resolve(jsonResponse({ name: "memos/saved_then_deleted" }));
        }
        return Promise.resolve(jsonResponse({}, 404));
      }),
    );
    expect(await emitRuntime(request)).toMatchObject({ ok: true });
    expect(await emitRuntime(request)).toEqual({ ok: false, errorKind: "not-found" });
    expect(posts).toBe(1);
    vi.unstubAllGlobals();
  });

  it("creates a memo and returns its web url when permitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ name: "memos/42", uid: "abc" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await emitRuntime({
      type: "SAVE_MEMO",
      content: "hello",
      visibility: "PRIVATE",
      ...expected,
    });

    expect(result).toEqual({ ok: true, webUrl: "https://memos.example.com/memos/abc" });
    expect(fetchMock).toHaveBeenCalledWith("https://memos.example.com/api/v1/memos", expect.objectContaining({ method: "POST" }));
    vi.unstubAllGlobals();
  });

  it("saves structured capture and reads current cloud history including archive and deletion", async () => {
    seedDirectConnection();
    let memo: Record<string, unknown> | null = null;
    const capture = {
      kind: "STAR",
      platform: "WEB",
      sourceUrl: "https://example.com/post",
      sourceId: "",
      comment: "My thought",
      context: "",
      posts: [],
    };
    const fetchMock = vi.fn((value: unknown, init?: RequestInit) => {
      const url = new URL(String(value));
      if (url.pathname.endsWith("/instance/profile"))
        return Promise.resolve(jsonResponse({ version: "dev", webClipperSupported: true, memoContentMaxBytes: 8192 }));
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        memo = {
          name: "memos/clip_record_123",
          uid: "abc",
          creator: "users/steven",
          createTime: new Date().toISOString(),
          state: "NORMAL",
          ...body,
        };
        return Promise.resolve(jsonResponse(memo));
      }
      if (url.pathname === "/api/v1/memos")
        return Promise.resolve(jsonResponse({ memos: memo && memo.state === url.searchParams.get("state") ? [memo] : [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const directExpected = {
      expectedSource: "direct" as const,
      expectedConnectionId: "direct_123",
      expectedInstanceUrl: testCreds.instanceUrl,
    };

    await emitRuntime({
      type: "SAVE_MEMO",
      content: "The final memo content",
      visibility: "PROTECTED",
      saveRequestId: "clip_record_123",
      saveStartedAt: 123,
      clip: {
        sourceUrl: "https://example.com/post?utm_source=newsletter",
        sourceTitle: "A useful post",
        selectionMarkdown: "The selected paragraph",
        imageCount: 1,
        capture,
      },
      ...directExpected,
    });
    expect(memo).toMatchObject({ capture });

    const status = await emitRuntime({
      type: "GET_CLIP_STATUS",
      sourceUrl: "https://example.com/post#section",
      ...directExpected,
    });
    expect(status).toMatchObject({
      memoUrl: "https://memos.example.com/memos/abc",
      savedAt: expect.any(Number),
    });

    const history = await emitRuntime({ type: "LIST_CLIP_RECORDS" }, optionsSender);
    expect(history).toEqual({
      ok: true,
      records: [
        expect.objectContaining({
          schemaVersion: 1,
          id: "memos/clip_record_123",
          memoContent: "The final memo content",
          visibility: "PROTECTED",
          memoName: "memos/clip_record_123",
          memoUrl: "https://memos.example.com/memos/abc",
        }),
      ],
    });
    memo = Object.assign({}, memo, { content: "Edited on the server", state: "ARCHIVED" });
    expect(await emitRuntime({ type: "LIST_CLIP_RECORDS" }, optionsSender)).toMatchObject({
      ok: true,
      records: [{ memoContent: "Edited on the server", state: "ARCHIVED" }],
    });
    memo = null;
    expect(await emitRuntime({ type: "LIST_CLIP_RECORDS" }, optionsSender)).toEqual({ ok: true, records: [] });
    expect(await emitRuntime({ type: "GET_CLIP_STATUS", sourceUrl: capture.sourceUrl, ...directExpected })).toBeNull();
    vi.unstubAllGlobals();
  });

  it("reloads metadata before choosing the destination instance", async () => {
    const fresh: MockUser = {
      id: "user_123",
      unsafeMetadata: {
        memos: { instanceUrl: "https://new.example.com", accessToken: "new-token" },
      },
    };
    mockUser = {
      id: "user_123",
      unsafeMetadata: memos(),
      reload: vi.fn(async () => fresh),
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ name: "memos/42", uid: "abc" }));
    vi.stubGlobal("fetch", fetchMock);

    await emitRuntime({
      type: "SAVE_MEMO",
      content: "hello",
      visibility: "PRIVATE",
      expectedSource: "usememos",
      expectedConnectionId: "user_123",
      expectedInstanceUrl: "https://new.example.com",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://new.example.com/api/v1/memos",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer new-token" }) }),
    );
    vi.unstubAllGlobals();
  });

  it("preserves legacy attachment-only behavior when inlineImages is absent", async () => {
    const fetchMock = vi.fn((url: unknown, _init?: unknown) => {
      const u = String(url);
      if (u === "https://cdn.example.com/x.png") {
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
      }
      if (u.endsWith("/api/v1/attachments")) return Promise.resolve(jsonResponse({ name: "attachments/9" }));
      if (u.endsWith("/api/v1/memos")) return Promise.resolve(jsonResponse({ name: "memos/7", uid: "xy" }));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await emitRuntime({
      type: "SAVE_MEMO",
      content: "hello\n\n![](https://cdn.example.com/x.png)",
      visibility: "PRIVATE",
      ...expected,
      images: ["https://cdn.example.com/x.png"],
    });

    expect(result).toEqual({ ok: true, webUrl: "https://memos.example.com/memos/xy" });
    const memoPost = fetchMock.mock.calls.find(
      ([u, init]) => String(u).endsWith("/api/v1/memos") && (init as { method: string }).method === "POST",
    );
    expect(JSON.parse((memoPost![1] as { body: string }).body).attachments).toEqual([{ name: "attachments/9" }]);
    expect(JSON.parse((memoPost![1] as { body: string }).body).content).toBe("hello\n\n![](https://cdn.example.com/x.png)");
    vi.unstubAllGlobals();
  });

  it("still saves the text and reports the count when an image upload fails", async () => {
    const fetchMock = vi.fn((url: unknown, _init?: unknown) => {
      const u = String(url);
      if (u === "https://cdn.example.com/broken.png") return Promise.resolve(new Response(null, { status: 404 }));
      if (u.endsWith("/api/v1/memos")) return Promise.resolve(jsonResponse({ name: "memos/7", uid: "xy" }));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await emitRuntime({
      type: "SAVE_MEMO",
      content: "hello",
      visibility: "PRIVATE",
      ...expected,
      images: ["https://cdn.example.com/broken.png"],
    });

    expect(result).toEqual({ ok: true, webUrl: "https://memos.example.com/memos/xy", failedImages: 1 });
    vi.unstubAllGlobals();
  });

  it("does not fetch an image from a private or loopback address", async () => {
    const privateImage = "https://127.0.0.1/admin.png";
    const mappedLoopbackImage = "https://[::ffff:127.0.0.1]/admin.png";
    const fetchMock = vi.fn((url: unknown) => {
      if (String(url).endsWith("/api/v1/memos")) return Promise.resolve(jsonResponse({ name: "memos/7", uid: "xy" }));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await emitRuntime({
      type: "SAVE_MEMO",
      content: "hello",
      visibility: "PRIVATE",
      ...expected,
      images: [privateImage, mappedLoopbackImage],
    });

    expect(result).toEqual({ ok: true, webUrl: "https://memos.example.com/memos/xy", failedImages: 2 });
    expect(fetchMock.mock.calls.some(([url]) => [privateImage, mappedLoopbackImage].includes(String(url)))).toBe(false);
    vi.unstubAllGlobals();
  });

  it("rejects an oversized image before buffering or uploading it", async () => {
    const fetchMock = vi.fn((url: unknown) => {
      const value = String(url);
      if (value === "https://cdn.example.com/huge.png") {
        return Promise.resolve(
          new Response(new Uint8Array([1]), {
            headers: { "content-type": "image/png", "content-length": String(10 * 1024 * 1024 + 1) },
          }),
        );
      }
      if (value.endsWith("/api/v1/memos")) return Promise.resolve(jsonResponse({ name: "memos/7", uid: "xy" }));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await emitRuntime({
      type: "SAVE_MEMO",
      content: "hello",
      visibility: "PRIVATE",
      ...expected,
      images: ["https://cdn.example.com/huge.png"],
    });

    expect(result).toEqual({ ok: true, webUrl: "https://memos.example.com/memos/xy", failedImages: 1 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/v1/attachments"))).toBe(false);
    vi.unstubAllGlobals();
  });

  it("rejects active SVG content instead of uploading it as an attachment", async () => {
    const fetchMock = vi.fn((url: unknown) => {
      const value = String(url);
      if (value === "https://cdn.example.com/active.svg") {
        return Promise.resolve(new Response("<svg><script>alert(1)</script></svg>", { headers: { "content-type": "image/svg+xml" } }));
      }
      if (value.endsWith("/api/v1/memos")) return Promise.resolve(jsonResponse({ name: "memos/7", uid: "xy" }));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await emitRuntime({
      type: "SAVE_MEMO",
      content: "hello",
      visibility: "PRIVATE",
      ...expected,
      images: ["https://cdn.example.com/active.svg"],
    });

    expect(result).toEqual({ ok: true, webUrl: "https://memos.example.com/memos/xy", failedImages: 1 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/v1/attachments"))).toBe(false);
    vi.unstubAllGlobals();
  });

  it("returns not-configured when there is no Memos connection", async () => {
    mockUser = { id: "user_123", unsafeMetadata: {} };
    const result = await emitRuntime({ type: "SAVE_MEMO", content: "hi", visibility: "PRIVATE", ...expected });
    expect(result).toEqual({ ok: false, errorKind: "not-configured" });
  });

  it("fails closed when the OAuth identity service is temporarily unavailable", async () => {
    oauthMocks.getOAuthUser.mockRejectedValueOnce(new oauthMocks.OAuthUnavailableError());
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await emitRuntime({ type: "SAVE_MEMO", content: "hi", visibility: "PRIVATE", ...expected });

    expect(result).toEqual({ ok: false, errorKind: "auth-unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("maps an InstanceError to its kind (401 -> unauthorized)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 401)));
    const result = await emitRuntime({ type: "SAVE_MEMO", content: "hi", visibility: "PRIVATE", ...expected });
    expect(result).toEqual({ ok: false, errorKind: "unauthorized" });
    vi.unstubAllGlobals();
  });

  it("reconciles the stable memo id before retrying an ambiguous create", async () => {
    const startedAt = Date.now();
    let postCount = 0;
    const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
      if (init?.method === "GET" && String(url).endsWith("/api/v1/auth/me")) {
        return Promise.resolve(jsonResponse({ user: { name: "users/steven" } }));
      }
      if (init?.method === "GET" && String(url).endsWith("/api/v1/memos/clip_retry_123")) {
        return Promise.resolve(
          jsonResponse({
            name: "memos/clip_retry_123",
            uid: "abc",
            creator: "users/steven",
            content: "hello",
            visibility: "PRIVATE",
            createTime: new Date(startedAt).toISOString(),
          }),
        );
      }
      if (init?.method === "POST" && String(url).includes("/api/v1/memos?memoId=")) {
        postCount += 1;
        return Promise.reject(Object.assign(new Error("response lost"), { name: "TimeoutError" }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      type: "SAVE_MEMO",
      content: "hello",
      visibility: "PRIVATE",
      saveRequestId: "clip_retry_123",
      saveStartedAt: startedAt,
      ...expected,
    };

    await expect(emitRuntime(request)).resolves.toEqual({ ok: false, errorKind: "timeout" });
    await expect(emitRuntime(request)).resolves.toEqual({ ok: true, webUrl: "https://memos.example.com/memos/abc" });
    expect(postCount).toBe(1);
    vi.unstubAllGlobals();
  });

  it("ignores unrelated message types", async () => {
    const result = await emitRuntime({ type: "SOMETHING_ELSE" });
    expect(result).toBeUndefined();
  });

  it("rejects a valid privileged message from a content script", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await emitRuntime(
      { type: "SAVE_MEMO", content: "hello", visibility: "PRIVATE", ...expected },
      { id: "test-id", url: "https://example.com/post" },
    );

    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects a stale account before making any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await emitRuntime({
      type: "SAVE_MEMO",
      content: "hello",
      visibility: "PRIVATE",
      expectedSource: "usememos",
      expectedConnectionId: "different_user",
      expectedInstanceUrl: testCreds.instanceUrl,
    });

    expect(result).toEqual({ ok: false, errorKind: "auth-changed" });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("background — popup state", () => {
  beforeEach(ready);

  it("returns and caches only non-secret display state", async () => {
    const result = await emitRuntime({ type: "GET_POPUP_STATE" });

    expect(result).toMatchObject({
      status: "ready",
      identity: { userId: "user_123", displayName: "Steven Li" },
      template: null,
      instanceUrl: testCreds.instanceUrl,
      version: "0.29.1",
    });
    expect(JSON.stringify(result)).not.toContain(testCreds.accessToken);
    expect(browserMock.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({ popupStateV1: result }));
  });

  it("shows the source choice when OAuth exists but no connection information is configured", async () => {
    mockUser = { id: "user_123", unsafeMetadata: {}, fullName: "Steven Li" };

    const result = await emitRuntime({ type: "GET_POPUP_STATE" });

    expect(result).toMatchObject({ status: "signed-out", source: null });
    expect(result).not.toHaveProperty("identity");
  });
});

describe("background — sanitized options protocol", () => {
  beforeEach(ready);

  it("returns identity fields without unsafe metadata or either access token", async () => {
    const result = await emitRuntime({ type: "GET_AUTH_USER" }, optionsSender);

    expect(result).toEqual({ id: "user_123", displayName: "Steven Li" });
    expect(JSON.stringify(result)).not.toContain("unsafeMetadata");
    expect(JSON.stringify(result)).not.toContain(testCreds.accessToken);
  });

  it("returns only sanitized connection diagnostics", async () => {
    const result = await emitRuntime({ type: "GET_CONNECTION_STATE", refresh: false }, optionsSender);

    expect(result).toEqual({
      source: "usememos",
      instanceUrl: testCreds.instanceUrl,
      version: "0.29.1",
      displayName: "Steven Li",
      status: "ready",
      verificationError: null,
      isUsingCachedVersion: true,
    });
    expect(JSON.stringify(result)).not.toContain(testCreds.accessToken);
  });
});

describe("background — direct connection", () => {
  it("verifies, stores, and returns a sanitized direct connection", async () => {
    mockUser = null;
    const fetchMock = vi.fn((url: unknown) => {
      if (String(url).endsWith("/api/v1/instance/profile")) return Promise.resolve(jsonResponse({ version: "0.29.1" }));
      if (String(url).endsWith("/api/v1/auth/me")) {
        return Promise.resolve(jsonResponse({ user: { name: "users/steven", displayName: "Steven" } }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await emitRuntime(
      { type: "CONNECT_DIRECT", instanceUrl: `${testCreds.instanceUrl}/`, accessToken: ` ${testCreds.accessToken} ` },
      optionsSender,
    );

    expect(result).toMatchObject({
      ok: true,
      state: {
        source: "direct",
        instanceUrl: testCreds.instanceUrl,
        displayName: "Steven",
        status: "ready",
      },
    });
    expect(JSON.stringify(result)).not.toContain(testCreds.accessToken);
    const stored = await browserMock.storage.local.get(CONNECTION_CONFIG_KEY);
    expect(stored).toMatchObject({
      [CONNECTION_CONFIG_KEY]: {
        schemaVersion: 1,
        activeSource: "direct",
        direct: {
          instanceUrl: testCreds.instanceUrl,
          accessToken: testCreds.accessToken,
          user: { name: "users/steven", displayName: "Steven" },
        },
      },
    });
    expect(oauthMocks.clearOAuthSession).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("does not persist credentials when token verification fails", async () => {
    mockUser = null;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 401)));

    const result = await emitRuntime(
      { type: "CONNECT_DIRECT", instanceUrl: testCreds.instanceUrl, accessToken: testCreds.accessToken },
      optionsSender,
    );

    expect(result).toEqual({ ok: false, errorKind: "unauthorized" });
    await expect(browserMock.storage.local.get(CONNECTION_CONFIG_KEY)).resolves.toEqual({});
    expect(oauthMocks.clearOAuthSession).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("requires explicit confirmation before sending credentials to remote HTTP", async () => {
    mockUser = null;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await emitRuntime(
      { type: "CONNECT_DIRECT", instanceUrl: "http://memos.example.com", accessToken: testCreds.accessToken },
      optionsSender,
    );

    expect(result).toEqual({ ok: false, errorKind: "mixed-content" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(browserMock.storage.local.get(CONNECTION_CONFIG_KEY)).resolves.toEqual({});
    vi.unstubAllGlobals();
  });

  it("rejects direct credentials from popup and content-script contexts", async () => {
    const request = { type: "CONNECT_DIRECT", instanceUrl: testCreds.instanceUrl, accessToken: testCreds.accessToken };
    await expect(emitRuntime(request, popupSender)).resolves.toBeUndefined();
    await expect(emitRuntime(request, { id: "test-id", url: "https://example.com" })).resolves.toBeUndefined();
    await expect(browserMock.storage.local.get(CONNECTION_CONFIG_KEY)).resolves.toEqual({});
  });

  it("saves with a direct connection while signed out of usememos.com", async () => {
    mockUser = null;
    seedDirectConnection();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ name: "memos/42", uid: "abc" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await emitRuntime({
      type: "SAVE_MEMO",
      content: "direct note",
      visibility: "PRIVATE",
      expectedSource: "direct",
      expectedConnectionId: "direct_123",
      expectedInstanceUrl: testCreds.instanceUrl,
    });

    expect(result).toEqual({ ok: true, webUrl: "https://memos.example.com/memos/abc" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://memos.example.com/api/v1/memos",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: `Bearer ${testCreds.accessToken}` }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("checks the stored PAT identity as well as the instance version", async () => {
    mockUser = null;
    seedDirectConnection();
    const fetchMock = vi.fn((url: unknown) => {
      if (String(url).endsWith("/api/v1/instance/profile")) return Promise.resolve(jsonResponse({ version: "0.29.1" }));
      if (String(url).endsWith("/api/v1/auth/me")) return Promise.resolve(jsonResponse({}, 401));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await emitRuntime({ type: "GET_CONNECTION_STATE", refresh: true }, optionsSender);

    expect(result).toMatchObject({
      source: "direct",
      status: "ready",
      verificationError: "unauthorized",
      isUsingCachedVersion: false,
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/v1/auth/me"))).toBe(true);
    vi.unstubAllGlobals();
  });

  it("returns success after commit even when post-commit OAuth cleanup fails", async () => {
    mockUser = null;
    oauthMocks.clearOAuthSession.mockRejectedValueOnce(new Error("storage unavailable"));
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) =>
        Promise.resolve(
          String(url).endsWith("/api/v1/instance/profile")
            ? jsonResponse({ version: "0.29.1" })
            : jsonResponse({ user: { name: "users/steven", displayName: "Steven" } }),
        ),
      ),
    );

    const result = await emitRuntime(
      { type: "CONNECT_DIRECT", instanceUrl: testCreds.instanceUrl, accessToken: testCreds.accessToken },
      optionsSender,
    );

    expect(result).toMatchObject({ ok: true, state: { source: "direct", status: "ready" } });
    await expect(browserMock.storage.local.get(CONNECTION_CONFIG_KEY)).resolves.toMatchObject({
      [CONNECTION_CONFIG_KEY]: { activeSource: "direct" },
    });
    vi.unstubAllGlobals();
  });

  it("does not let a stale verification reactivate after disconnect", async () => {
    mockUser = null;
    let releaseProfile!: (response: Response) => void;
    let markProfileStarted!: () => void;
    const profileStarted = new Promise<void>((resolve) => {
      markProfileStarted = resolve;
    });
    const profileResponse = new Promise<Response>((resolve) => {
      releaseProfile = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        if (String(url).endsWith("/api/v1/instance/profile")) {
          markProfileStarted();
          return profileResponse;
        }
        return Promise.resolve(jsonResponse({ user: { name: "users/steven" } }));
      }),
    );

    const connecting = emitRuntime(
      { type: "CONNECT_DIRECT", instanceUrl: testCreds.instanceUrl, accessToken: testCreds.accessToken },
      optionsSender,
    );
    await profileStarted;
    await emitRuntime({ type: "DISCONNECT_CONNECTION" }, optionsSender);
    releaseProfile(jsonResponse({ version: "0.29.1" }));

    await expect(connecting).resolves.toEqual({ ok: false, errorKind: "auth-changed" });
    await expect(browserMock.storage.local.get(CONNECTION_CONFIG_KEY)).resolves.toEqual({
      [CONNECTION_CONFIG_KEY]: { schemaVersion: 1, activeSource: null },
    });
    vi.unstubAllGlobals();
  });
});

describe("background — sign-out", () => {
  beforeEach(ready);

  it("clears popup, version, and ambiguous-save caches before broadcasting", async () => {
    seedStorage({
      [POPUP_STATE_KEY]: { status: "ready" },
      [VERSION_CACHE_KEY]: { instanceUrl: testCreds.instanceUrl, version: "0.29.1" },
      [SAVE_ATTEMPTS_KEY]: { request_1: { fingerprint: "x", startedAt: Date.now() } },
    });

    await emitRuntime({ type: "SIGN_OUT" }, optionsSender);

    await expect(browserMock.storage.local.get([POPUP_STATE_KEY, VERSION_CACHE_KEY, SAVE_ATTEMPTS_KEY])).resolves.toEqual({});
    expect(oauthMocks.clearOAuthSession).toHaveBeenCalledOnce();
    expect(browserMock.runtime.sendMessage).toHaveBeenCalledWith({ type: "AUTH_CHANGED" });
  });

  it("clears a legacy local session without calling OAuth userinfo", async () => {
    oauthMocks.getOAuthUser.mockRejectedValue(new oauthMocks.OAuthUnavailableError());

    await expect(emitRuntime({ type: "SIGN_OUT" }, optionsSender)).resolves.toBeUndefined();

    expect(oauthMocks.getOAuthUser).not.toHaveBeenCalled();
    expect(oauthMocks.clearOAuthSession).toHaveBeenCalledOnce();
    await expect(browserMock.storage.local.get(CONNECTION_CONFIG_KEY)).resolves.toEqual({
      [CONNECTION_CONFIG_KEY]: { schemaVersion: 1, activeSource: null },
    });
  });
});

describe("background — sign-in flow", () => {
  it("runs OAuth PKCE, refreshes state, and returns to options", async () => {
    ready();
    await emitRuntime({ type: "OPEN_SIGN_IN" });
    expect(oauthMocks.beginOAuthSignIn).toHaveBeenCalledOnce();
    expect(browserMock.runtime.sendMessage).toHaveBeenCalledWith({ type: "AUTH_CHANGED" });
    expect(browserMock.runtime.openOptionsPage).toHaveBeenCalled();
    expect(browserMock.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ popupStateV1: expect.objectContaining({ status: "ready" }) }),
    );
  });
});

describe("background — onInstalled", () => {
  it("registers a single context menu covering selection and image", async () => {
    await browserMock.runtime.onInstalled.emit();
    expect(browserMock.contextMenus.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "save-selection", contexts: ["selection", "image"] }),
    );
    expect(browserMock.contextMenus.create).not.toHaveBeenCalledWith(expect.objectContaining({ id: "save-image" }));
  });

  it("registers the context menu in German", async () => {
    setBrowserLocale("de", germanMessages);
    await browserMock.runtime.onInstalled.emit();

    expect(browserMock.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({ title: "Auswahl in Memos speichern" }));
    expect(browserMock.action.setTitle).toHaveBeenCalledWith({ title: "In Memos speichern" });
  });

  it("updates browser UI after a manual locale change", async () => {
    await browserMock.storage.onChanged.emit({ [LOCALE_PREFERENCE_KEY]: { newValue: "de" } }, "local");

    expect(browserMock.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({ title: "Auswahl in Memos speichern" }));
    expect(browserMock.action.setTitle).toHaveBeenCalledWith({ title: "In Memos speichern" });
  });
});

describe("background — context menu quick save", () => {
  const click = () =>
    browserMock.contextMenus.onClicked.emit(
      { menuItemId: "save-selection", selectionText: "clip me", pageUrl: "https://example.com/post" },
      { id: 5, title: "Post" },
    );

  it("ready → saves the selection through the template and flashes a success badge", async () => {
    ready();
    seedStorage({ [CLIP_TEMPLATE_KEY]: "{{content}}\n\nSource: {{url}} #local-template" });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ name: "memos/7", uid: "xy" }));
    vi.stubGlobal("fetch", fetchMock);

    await click();

    expect(browserMock.action.setBadgeText).toHaveBeenCalledWith({ text: "✓" });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.content).toContain("clip me");
    expect(body.content).toContain("https://example.com/post");
    expect(body.content).toContain("#local-template");
    // After a successful save, the page selection is cleared and an in-page toast is shown.
    expect(browserMock.tabs.sendMessage).toHaveBeenCalledWith(5, { type: "CLEAR_SELECTION" });
    expect(browserMock.tabs.sendMessage).toHaveBeenCalledWith(5, {
      type: "SHOW_SAVE_RESULT",
      ok: true,
      title: "Saved to Memos",
      webUrl: "https://memos.example.com/memos/xy",
      openLabel: "Open",
      direction: "ltr",
    });
    vi.unstubAllGlobals();
  });

  it("failed save → shows an error toast in the page, no selection clear", async () => {
    ready();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 401)));

    await click();

    expect(browserMock.tabs.sendMessage).toHaveBeenCalledWith(
      5,
      expect.objectContaining({
        type: "SHOW_SAVE_RESULT",
        ok: false,
        // The in-page toast has no buttons, so the first fix step rides along in the text.
        title: "Access token rejected — Sign in to usememos.com and reconnect.",
      }),
    );
    expect(browserMock.tabs.sendMessage).not.toHaveBeenCalledWith(5, { type: "CLEAR_SELECTION" });
    vi.unstubAllGlobals();
  });

  it("ready + text/image selection → saves the text and attaches the image to the memo", async () => {
    ready();
    // Content script preserves the selected image in Markdown.
    browserMock.tabs.sendMessage.mockImplementation(async (_id: number, msg: unknown) => {
      if ((msg as { type: string }).type === "GET_SELECTION") {
        return { markdown: "hello world\n\n![](https://cdn.example.com/x.png)", images: ["https://cdn.example.com/x.png"] };
      }
      return undefined;
    });
    const fetchMock = vi.fn((url: unknown, _init?: unknown) => {
      const u = String(url);
      if (u === "https://cdn.example.com/x.png") {
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
      }
      if (new URL(u).pathname.endsWith("/api/v1/attachments")) {
        const id = new URL(u).searchParams.get("attachmentId");
        const body = JSON.parse(String((_init as RequestInit)?.body));
        return Promise.resolve(jsonResponse({ name: `attachments/${id}`, filename: body.filename }));
      }
      if (u.endsWith("/api/v1/memos")) return Promise.resolve(jsonResponse({ name: "memos/7", uid: "xy" }));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await browserMock.contextMenus.onClicked.emit(
      { menuItemId: "save-selection", selectionText: "hello world", pageUrl: "https://example.com/post" },
      { id: 5, title: "Post" },
    );

    // The selected image keeps its inline location and is associated atomically.
    const memoPost = fetchMock.mock.calls.find(
      ([u, init]) => String(u).endsWith("/api/v1/memos") && (init as { method: string }).method === "POST",
    );
    expect(JSON.parse((memoPost![1] as { body: string }).body).content).toContain("hello world");
    expect(JSON.parse((memoPost![1] as { body: string }).body).attachments).toEqual([
      { name: expect.stringMatching(/^attachments\/clip/) },
    ]);
    expect(JSON.parse((memoPost![1] as { body: string }).body).content).toContain("/file/attachments/clip");
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/api/v1/memos/7/attachments"))).toBe(false);
    expect(browserMock.action.setBadgeText).toHaveBeenCalledWith({ text: "✓" });
    vi.unstubAllGlobals();
  });

  it("signed out → opens settings to choose a source, no save", async () => {
    mockUser = null;
    await click();
    expect(oauthMocks.beginOAuthSignIn).not.toHaveBeenCalled();
    expect(browserMock.runtime.openOptionsPage).toHaveBeenCalled();
  });

  it("connected but no version match → opens the options page, no save", async () => {
    mockUser = { id: "user_123", unsafeMetadata: memos() };
    seedVersion("0.21.0");
    await click();
    expect(browserMock.runtime.openOptionsPage).toHaveBeenCalled();
    expect(browserMock.action.setBadgeText).not.toHaveBeenCalled();
  });

  it("not connected → opens the options page, no save", async () => {
    mockUser = { id: "user_123", unsafeMetadata: {} };
    await click();
    expect(browserMock.runtime.openOptionsPage).toHaveBeenCalled();
  });

  it("ready + image → uploads the image, attaches it to a memo, and flashes a success badge", async () => {
    ready();
    const fetchMock = vi.fn((url: unknown, _init?: unknown) => {
      const u = String(url);
      if (u === "https://cdn.example.com/pic.png") {
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
      }
      if (new URL(u).pathname.endsWith("/api/v1/attachments")) {
        const id = new URL(u).searchParams.get("attachmentId");
        const body = JSON.parse(String((_init as RequestInit)?.body));
        return Promise.resolve(jsonResponse({ name: `attachments/${id}`, filename: body.filename }));
      }
      if (u.endsWith("/api/v1/memos")) return Promise.resolve(jsonResponse({ name: "memos/7", uid: "xy" }));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await browserMock.contextMenus.onClicked.emit(
      { menuItemId: "save-selection", srcUrl: "https://cdn.example.com/pic.png", pageUrl: "https://example.com/post" },
      { id: 5, title: "Post" },
    );

    expect(browserMock.action.setBadgeText).toHaveBeenCalledWith({ text: "✓" });
    const attach = fetchMock.mock.calls.find(([u]) => new URL(String(u)).pathname.endsWith("/api/v1/attachments"));
    const attachBody = JSON.parse((attach![1] as { body: string }).body);
    expect(attachBody.type).toBe("image/png");
    expect(typeof attachBody.content).toBe("string"); // base64
    const memoPost = fetchMock.mock.calls.find(
      ([u, init]) => String(u).endsWith("/api/v1/memos") && (init as { method: string }).method === "POST",
    );
    expect(JSON.parse((memoPost![1] as { body: string }).body).attachments).toEqual([
      { name: expect.stringMatching(/^attachments\/clip/) },
    ]);
    expect(JSON.parse((memoPost![1] as { body: string }).body).content).toContain("/file/attachments/clip");
    vi.unstubAllGlobals();
  });

  it("does nothing without a text selection", async () => {
    ready();
    await browserMock.contextMenus.onClicked.emit({ menuItemId: "save-selection" }, { id: 5, title: "T" });
    expect(browserMock.action.setBadgeText).not.toHaveBeenCalled();
    expect(browserMock.runtime.openOptionsPage).not.toHaveBeenCalled();
  });

  it("ignores clicks on other menu items", async () => {
    await browserMock.contextMenus.onClicked.emit({ menuItemId: "something-else", selectionText: "x" }, { id: 5 });
    expect(browserMock.action.setBadgeText).not.toHaveBeenCalled();
  });
});

describe("background — GET_MEMO_TAGS", () => {
  beforeEach(ready);
  it("rejects stale lookup identities before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await emitRuntime({ type: "GET_MEMO_TAGS", ...expected, expectedConnectionId: "stale" })).toEqual({
      ok: false,
      errorKind: "auth-changed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("drops tag results if credentials change while loading", async () => {
    const fetchMock = vi.fn(async (value: unknown) => {
      if (String(value).endsWith("/auth/me")) return jsonResponse({ user: { name: "users/steven" } });
      mockUser = { id: "user_123", unsafeMetadata: memos({ accessToken: "replaced" }) };
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await emitRuntime({ type: "GET_MEMO_TAGS", ...expected })).toEqual({ ok: false, errorKind: "auth-changed" });
    vi.unstubAllGlobals();
  });
});
