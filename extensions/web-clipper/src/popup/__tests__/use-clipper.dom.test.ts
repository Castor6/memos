import { beforeEach, describe, expect, it, vi } from "vitest";
import { composeCaptureMemo } from "@/lib/capture-format";
import { LAST_VISIBILITY_KEY } from "@/lib/visibility";
import type { XCaptureResult } from "@/lib/x-capture";
import { browserMock, seedStorage } from "@/test/browser-mock";
import { act, renderHook, waitFor } from "@/test/render";
import { captureActivePage, type PageCapture } from "../page-capture";
import { useClipper } from "../use-clipper";

vi.mock("../page-capture", () => ({ captureActivePage: vi.fn() }));

const page: PageCapture = {
  title: "Hello World",
  url: "https://example.com/post",
  description: "A page about greetings",
  selectionMarkdown: "> Selected words",
  articleMarkdown: "Full article",
  images: ["https://cdn.example.com/image.png"],
};
const expectation = { source: "direct" as const, connectionId: "user_123", instanceUrl: "https://memos.example.com" };
const xUrl = "https://x.com/me/status/300";
const xResult: XCaptureResult = {
  capture: {
    kind: "PICK_UP",
    platform: "X",
    sourceUrl: xUrl,
    sourceId: "300",
    comment: "My published reply",
    context: "",
    posts: [
      {
        id: "200",
        url: "https://x.com/parent/status/200",
        author: "@parent",
        authorName: "Parent",
        content: "Their idea",
        publishedAt: "2026-09-22T08:00:00Z",
        images: [],
      },
      {
        id: "300",
        url: xUrl,
        author: "@me",
        authorName: "Me",
        content: "My published reply",
        publishedAt: "2026-09-22T09:00:00Z",
        images: [],
      },
    ],
  },
  title: "My reply",
  images: [],
  warnings: ["Some context may be missing"],
  isOwnPost: true,
};
const useReadyClipper = () => useClipper(expectation, null);
const saves = () =>
  browserMock.runtime.sendMessage.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.type === "SAVE_MEMO");

function wireRuntime(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    GET_CAPTURE_CAPABILITIES: { ok: true, supported: true, contentMaxBytes: 8192 },
    GET_CLIP_STATUS: null,
    GET_MEMO_TAGS: { ok: true, tags: ["阅读", "项目/灵感"] },
    SAVE_MEMO: { ok: true, webUrl: "https://memos.example.com/memos/1" },
    ...overrides,
  };
  browserMock.runtime.sendMessage.mockImplementation(async (message: unknown) => responses[(message as { type: string }).type]);
}

async function waitReady(result: { current: ReturnType<typeof useClipper> }) {
  await waitFor(() => expect(result.current.ready).toBe(true));
  await waitFor(() => expect(result.current.capabilities).not.toBeNull());
}

describe("useClipper manual capture and durable drafts", () => {
  beforeEach(() => {
    wireRuntime();
    browserMock.tabs.query.mockResolvedValue([{ id: 4, url: page.url, title: page.title }]);
    vi.mocked(captureActivePage).mockReset().mockResolvedValue(page);
    browserMock.scripting.executeScript.mockImplementation(async (options: unknown) => {
      const mode = (options as { args: string[] }).args[0];
      return [
        {
          result:
            mode === "STAR"
              ? {
                  ...xResult,
                  capture: { ...xResult.capture!, kind: "STAR", comment: "", posts: [xResult.capture!.posts[1]!] },
                }
              : xResult,
        },
      ];
    });
  });

  it("reads only tab metadata on open and never captures until the user chooses a mode", async () => {
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    expect(result.current.draft).toBeNull();
    expect(captureActivePage).not.toHaveBeenCalled();
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(browserMock.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    await act(async () => {
      expect((await result.current.save()).ok).toBe(false);
    });
    expect(saves()).toHaveLength(0);
  });

  it("preserves and restores a bound draft after the original page navigates or closes", async () => {
    const source = { id: 4, url: page.url };
    const { result, unmount } = renderHook(() => useClipper(expectation, null, source));
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    expect(captureActivePage).toHaveBeenCalledWith(4);
    await act(async () => result.current.update({}, { comment: "Keep this thought" }));
    await act(async () => {
      await browserMock.tabs.onUpdated.emit(4, { url: "https://other.example.com" }, { id: 4, url: "https://other.example.com" });
    });
    expect(result.current.draft?.capture.comment).toBe("Keep this thought");
    browserMock.tabs.get.mockRejectedValue(new Error("closed"));
    browserMock.tabs.query.mockResolvedValue([]);
    await act(async () => result.current.start("STAR", true));
    expect(result.current.notice).toContain("当前草稿已保留");
    expect(result.current.draft?.capture.comment).toBe("Keep this thought");
    unmount();
    const reopened = renderHook(() => useClipper(expectation, null, source));
    await waitReady(reopened.result);
    expect(reopened.result.current.draft?.capture.comment).toBe("Keep this thought");
    await act(async () => {
      expect((await reopened.result.current.save()).ok).toBe(true);
    });
  });

  it("Star accepts ordinary websites and prefers the selected content with the configured template", async () => {
    const { result } = renderHook(() => useClipper(expectation, "{{title}}\n{{content}}\n{{url}}"));
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    expect(result.current.draft?.capture).toMatchObject({ kind: "STAR", platform: "WEB", sourceUrl: page.url, comment: "" });
    expect(result.current.draft?.original).toContain("> Selected words");
    expect(result.current.draft?.original).not.toContain("Full article");
    act(() => result.current.update({}, { comment: "我的思考" }));
    expect(result.current.content.indexOf("我的思考")).toBeLessThan(result.current.content.indexOf("Selected words"));
    await act(async () => {
      expect((await result.current.save()).ok).toBe(true);
    });
    expect(saves()[0]).toMatchObject({
      content: result.current.content,
      images: [],
      inlineImages: true,
      tags: ["star"],
      expectedSource: "direct",
      expectedConnectionId: "user_123",
      expectedInstanceUrl: expectation.instanceUrl,
      clip: { capture: { kind: "STAR", comment: "我的思考" } },
    });
    expect(saves()[0]).not.toHaveProperty("credentials");
  });

  it("restores a page draft after closing, with no new extraction", async () => {
    const first = renderHook(useReadyClipper);
    await waitReady(first.result);
    await act(async () => first.result.current.start("STAR"));
    await act(async () =>
      first.result.current.update({ original: "Edited source", tags: ["star", "阅读"] }, { comment: "Keep my thoughts" }),
    );
    first.unmount();
    vi.mocked(captureActivePage).mockClear();
    const reopened = renderHook(useReadyClipper);
    await waitReady(reopened.result);
    expect(reopened.result.current.draft?.capture.comment).toBe("Keep my thoughts");
    expect(reopened.result.current.draft?.original).toBe("Edited source");
    expect(reopened.result.current.draft?.tags).toEqual(["star", "阅读"]);
    expect(captureActivePage).not.toHaveBeenCalled();
  });

  it("preserves an explicitly empty tag list when refreshing and reopening", async () => {
    const first = renderHook(useReadyClipper);
    await waitReady(first.result);
    await act(async () => first.result.current.start("STAR"));
    await waitFor(() => expect(first.result.current.tagSuggestions).toEqual(["阅读", "项目/灵感"]));
    await act(async () => first.result.current.update({ tags: [] }));
    await act(async () => first.result.current.start("STAR", true));
    expect(first.result.current.draft?.tags).toEqual([]);
    first.unmount();
    const reopened = renderHook(useReadyClipper);
    await waitReady(reopened.result);
    expect(reopened.result.current.draft?.tags).toEqual([]);
    await act(async () => reopened.result.current.save());
    expect(saves()[0]?.tags).toEqual([]);
  });

  it("keeps legacy pending saves byte-identical and adds default tags only to subsequent saves", async () => {
    browserMock.tabs.query.mockResolvedValue([{ id: 4, url: xUrl }]);
    const first = renderHook(useReadyClipper);
    await waitReady(first.result);
    await act(async () => first.result.current.start("PICK_UP"));
    const stored = await browserMock.storage.local.get(null);
    const key = Object.keys(stored).find((key) => key.endsWith(":PICK_UP"))!;
    const legacy = { ...(stored[key] as Record<string, unknown>) };
    delete legacy.tags;
    legacy.operation = { requestId: "old-pending-operation", startedAt: Date.now() };
    first.unmount();
    seedStorage({ [key]: legacy });
    const reopened = renderHook(useReadyClipper);
    await waitReady(reopened.result);
    expect(reopened.result.current.awaitingConfirmation).toBe(true);
    expect(reopened.result.current.content).toBe(composeCaptureMemo(xResult.capture!, String(legacy.original), true));
    await act(async () => reopened.result.current.save());
    expect(saves()[0]).not.toHaveProperty("tags");
    expect(String(saves()[0]?.content)).toContain("## 我的评论");
    await act(async () => reopened.result.current.save());
    expect(saves()[1]?.tags).toEqual(["pick up"]);
    expect(String(saves()[1]?.content)).toContain("## Pick up");
  });

  it.each([false, true])("preserves images in pre-inline drafts without changing a pending request (pending=%s)", async (pending) => {
    const first = renderHook(useReadyClipper);
    await waitReady(first.result);
    await act(async () => first.result.current.start("STAR"));
    const stored = await browserMock.storage.local.get(null);
    const key = Object.keys(stored).find((key) => key.endsWith(":STAR"))!;
    const old: Record<string, unknown> = {
      ...(stored[key] as Record<string, unknown>),
      original: "User-edited original",
      images: page.images,
    };
    delete old.imageLayout;
    old.operation = pending ? { requestId: "old-image-operation", startedAt: Date.now(), content: "Frozen old body" } : null;
    first.unmount();
    seedStorage({ [key]: old });
    const reopened = renderHook(useReadyClipper);
    await waitReady(reopened.result);
    expect(reopened.result.current.content).toContain(pending ? "Frozen old body" : page.images[0]!);
    await act(async () => reopened.result.current.save());
    if (pending) {
      expect(saves()[0]).toMatchObject({ content: "Frozen old body", images: page.images, inlineImages: false });
      await act(async () => reopened.result.current.save());
    }
    expect(saves().at(-1)).toMatchObject({ inlineImages: true, images: [] });
    expect(String(saves().at(-1)?.content)).toContain(`User-edited original\n\n![](<${page.images[0]}>)`);
  });

  it("checks an embedded image against the estimated archived size before allowing the upload", async () => {
    const dataImage = `data:image/png;base64,${"A".repeat(20_000)}`;
    vi.mocked(captureActivePage).mockResolvedValue({
      ...page,
      images: [dataImage],
      selectionMarkdown: `Before\n\n![image](${dataImage})\n\nAfter`,
    });
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    expect(result.current.content.length).toBeGreaterThan(20_000);
    expect(result.current.contentBytes).toBeLessThan(8192);
    expect(result.current.overLimit).toBe(false);
    await act(async () => expect((await result.current.save()).ok).toBe(true));
    expect(saves()[0]).toMatchObject({ inlineImages: true });
  });

  it("ignores tag suggestions arriving after switching accounts", async () => {
    let resolveTags!: (value: unknown) => void;
    wireRuntime({
      GET_MEMO_TAGS: new Promise((resolve) => {
        resolveTags = resolve;
      }),
    });
    const { result, rerender } = renderHook(({ account }) => useClipper(account, null), { initialProps: { account: expectation } });
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    await waitFor(() => expect(result.current.tagsLoading).toBe(true));
    rerender({ account: { ...expectation, connectionId: "another_user" } });
    await waitFor(() => expect(result.current.draft).toBeNull());
    await act(async () => resolveTags({ ok: true, tags: ["旧账号私有标签"] }));
    expect(result.current.tagSuggestions).toEqual([]);
  });

  it("can save new tags while existing tag suggestions are unavailable", async () => {
    wireRuntime({ GET_MEMO_TAGS: { ok: false, errorKind: "timeout" } });
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    await waitFor(() => expect(result.current.tagsError).toContain("已有标签读取失败"));
    await act(async () => result.current.update({ tags: ["star", "新标签"] }));
    await act(async () => result.current.save());
    expect(saves()[0]?.tags).toEqual(["star", "新标签"]);
  });

  it("keeps Star and Pick up drafts separately on the same page", async () => {
    browserMock.tabs.query.mockResolvedValue([{ id: 4, url: xUrl }]);
    vi.mocked(captureActivePage).mockResolvedValue({ ...page, url: xUrl });
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    expect(result.current.draft?.tags).toEqual(["star"]);
    await act(async () => result.current.update({}, { comment: "Star thoughts" }));
    await act(async () => result.current.start("PICK_UP"));
    expect(result.current.draft?.tags).toEqual(["pick up"]);
    await act(async () => result.current.update({}, { context: "Why I replied" }));
    expect(result.current.draft?.original).toContain("Their idea");
    expect(result.current.draft?.original).not.toContain("My published reply");
    await act(async () => result.current.start("STAR"));
    expect(result.current.draft?.capture.comment).toBe("Star thoughts");
    await act(async () => result.current.start("PICK_UP"));
    expect(result.current.draft?.capture.context).toBe("Why I replied");
    expect(browserMock.scripting.executeScript).toHaveBeenCalledTimes(2);
    expect(captureActivePage).not.toHaveBeenCalled();
  });

  it("uses X's dedicated Star extractor for short posts and allows saving another author's post", async () => {
    browserMock.tabs.query.mockResolvedValue([{ id: 4, url: xUrl }]);
    browserMock.scripting.executeScript.mockResolvedValue([
      {
        result: {
          ...xResult,
          isOwnPost: false,
          capture: { ...xResult.capture!, kind: "STAR", comment: "", posts: [{ ...xResult.capture!.posts[1]!, content: "好" }] },
        },
      },
    ]);
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    expect(captureActivePage).not.toHaveBeenCalled();
    expect(browserMock.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ args: ["STAR"] }));
    expect(result.current.draft?.capture).toMatchObject({ kind: "STAR", platform: "X", comment: "" });
    expect(result.current.draft?.original).toContain("好");
    expect(result.current.draft?.original).toContain(`[来源](${xUrl})`);
    expect(result.current.draft?.confirmed).toBe(true);
    await act(async () => result.current.update({}, { comment: "This matters to me" }));
    await act(async () => result.current.start("STAR", true));
    expect(result.current.draft?.capture.comment).toBe("This matters to me");
    await act(async () => {
      expect((await result.current.save()).ok).toBe(true);
    });
  });

  it("refreshes captured source while preserving thoughts and context", async () => {
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    await act(async () => result.current.update({}, { comment: "My thoughts", context: "My context" }));
    vi.mocked(captureActivePage).mockResolvedValue({ ...page, selectionMarkdown: "Updated source" });
    await act(async () => result.current.start("STAR", true));
    expect(result.current.draft?.original).toContain("Updated source");
    expect(result.current.draft?.capture).toMatchObject({ comment: "My thoughts", context: "My context" });
  });

  it("does not overwrite an edit made while a refresh is in flight", async () => {
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    let resolveCapture!: (value: PageCapture) => void;
    vi.mocked(captureActivePage).mockReturnValue(
      new Promise((resolve) => {
        resolveCapture = resolve;
      }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.start("STAR", true);
    });
    act(() => result.current.update({ original: "User edited source" }, { comment: "User input" }));
    await act(async () => {
      resolveCapture({ ...page, selectionMarkdown: "Late content" });
      await pending;
    });
    expect(result.current.draft?.original).toBe("User edited source");
    expect(result.current.draft?.capture.comment).toBe("User input");
    expect(result.current.notice).toContain("已保留你的输入");
  });

  it("discards an extraction after account switching and isolates the new account's draft", async () => {
    const { result, rerender } = renderHook(({ account }) => useClipper(account, null), { initialProps: { account: expectation } });
    await waitReady(result);
    let resolveCapture!: (value: PageCapture) => void;
    vi.mocked(captureActivePage).mockReturnValue(
      new Promise((resolve) => {
        resolveCapture = resolve;
      }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.start("STAR");
    });
    rerender({ account: { ...expectation, connectionId: "other_user" } });
    await waitReady(result);
    await act(async () => {
      resolveCapture(page);
      await pending;
    });
    expect(result.current.draft).toBeNull();
    expect(saves()).toHaveLength(0);
  });

  it("preserves the visible draft during temporary auth loss and retries the same operation after the same account returns", async () => {
    wireRuntime({ SAVE_MEMO: { ok: false, errorKind: "timeout" } });
    const { result, rerender } = renderHook(({ account }: { account: typeof expectation | null }) => useClipper(account, null), {
      initialProps: { account: expectation as typeof expectation | null },
    });
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    await act(async () => result.current.update({}, { comment: "Keep these thoughts visible" }));
    await act(async () => {
      await result.current.save();
    });
    const requestId = result.current.draft?.operation?.requestId;
    rerender({ account: null });
    expect(result.current.draft?.capture.comment).toBe("Keep these thoughts visible");
    expect(result.current.draft?.operation?.requestId).toBe(requestId);
    act(() => result.current.update({}, { comment: "Blocked edit" }));
    expect(result.current.draft?.capture.comment).toBe("Keep these thoughts visible");
    await act(async () => {
      expect(await result.current.save()).toEqual({ ok: false, errorKind: "not-configured" });
    });
    expect(saves()).toHaveLength(1);
    wireRuntime();
    rerender({ account: expectation });
    await waitReady(result);
    await act(async () => {
      expect((await result.current.save()).ok).toBe(true);
    });
    expect(saves()[1]?.saveRequestId).toBe(requestId);
  });

  it("does not reuse the retained draft when a different account replaces unavailable auth", async () => {
    const { result, rerender } = renderHook(({ account }: { account: typeof expectation | null }) => useClipper(account, null), {
      initialProps: { account: expectation as typeof expectation | null },
    });
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    await act(async () => result.current.update({}, { comment: "Account A thoughts" }));
    rerender({ account: null });
    expect(result.current.draft?.capture.comment).toBe("Account A thoughts");
    rerender({ account: { ...expectation, connectionId: "account_b" } });
    await waitReady(result);
    expect(result.current.draft).toBeNull();
    await act(async () => {
      expect((await result.current.save()).ok).toBe(false);
    });
    expect(saves()).toHaveLength(0);
    rerender({ account: expectation });
    await waitReady(result);
    expect(result.current.draft?.capture.comment).toBe("Account A thoughts");
  });

  it("checks current auth again after persisting and before sending a save", async () => {
    const { result, rerender } = renderHook(({ account }: { account: typeof expectation | null }) => useClipper(account, null), {
      initialProps: { account: expectation as typeof expectation | null },
    });
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    const write = browserMock.storage.local.set.getMockImplementation()!;
    let releaseWrite!: () => void;
    browserMock.storage.local.set.mockImplementationOnce(async (items) => {
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      await write(items);
    });
    let pending!: ReturnType<typeof result.current.save>;
    act(() => {
      pending = result.current.save();
    });
    await waitFor(() => expect(releaseWrite).toBeDefined());
    const requestId = result.current.draft?.operation?.requestId;
    rerender({ account: null });
    await act(async () => {
      releaseWrite();
      expect(await pending).toEqual({ ok: false, errorKind: "auth-changed" });
    });
    expect(saves()).toHaveLength(0);
    expect(result.current.draft?.operation?.requestId).toBe(requestId);
    rerender({ account: expectation });
    await waitReady(result);
    await act(async () => {
      expect((await result.current.save()).ok).toBe(true);
    });
    expect(saves()[0]?.saveRequestId).toBe(requestId);
  });

  it("clears the visible draft when the same tab navigates to another page", async () => {
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    await act(async () => {
      await browserMock.tabs.onUpdated.emit(4, { url: "https://example.com/other" }, { id: 4, url: "https://example.com/other" });
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.draft).toBeNull();
  });

  it("rejects Pick up on ordinary sites without injecting a script", async () => {
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("PICK_UP"));
    expect(result.current.draft).toBeNull();
    expect(result.current.notice).toContain("X 回复");
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("requires confirmation when X cannot establish the signed-in author and rejects another author's post", async () => {
    browserMock.tabs.query.mockResolvedValue([{ id: 4, url: xUrl }]);
    browserMock.scripting.executeScript.mockResolvedValue([{ result: { ...xResult, isOwnPost: false } }]);
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("PICK_UP"));
    expect(result.current.draft).toBeNull();
    expect(result.current.notice).toContain("不属于");
    browserMock.scripting.executeScript.mockResolvedValue([{ result: { ...xResult, isOwnPost: null } }]);
    await act(async () => result.current.start("PICK_UP"));
    expect(result.current.draft?.confirmed).toBe(false);
    await act(async () => {
      expect((await result.current.save()).ok).toBe(false);
    });
    expect(saves()).toHaveLength(0);
    act(() => result.current.update({ confirmed: true }, { context: "A personal background" }));
    await act(async () => {
      expect((await result.current.save()).ok).toBe(true);
    });
    expect(saves()[0]).toMatchObject({
      clip: { capture: { kind: "PICK_UP", comment: "My published reply", context: "A personal background" } },
    });
  });

  it("checks the exact final UTF-8 byte count including Chinese, emoji, and formatting", async () => {
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    act(() => result.current.update({}, { comment: "中文" }));
    const exactLimit = new TextEncoder().encode(result.current.content).byteLength;
    expect(result.current.contentBytes).toBe(exactLimit);
    wireRuntime({ GET_CAPTURE_CAPABILITIES: { ok: true, supported: true, contentMaxBytes: exactLimit } });
    act(() => result.current.retryCapabilities());
    await waitFor(() => expect(result.current.capabilities?.contentMaxBytes).toBe(exactLimit));
    expect(result.current.overLimit).toBe(false);
    await act(async () => {
      expect((await result.current.save()).ok).toBe(true);
    });
    act(() => result.current.update({}, { comment: "中文🙂" }));
    expect(result.current.contentBytes).toBe(exactLimit + 4);
    expect(result.current.overLimit).toBe(true);
    await act(async () => {
      expect(await result.current.save()).toMatchObject({ ok: false, errorKind: "content-too-large", contentMaxBytes: exactLimit });
    });
    expect(saves()).toHaveLength(1);
  });

  it("requires server support and surfaces capability/status failures separately", async () => {
    wireRuntime({ GET_CAPTURE_CAPABILITIES: { ok: true, supported: false, contentMaxBytes: 8192 } });
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    await act(async () => {
      expect(await result.current.save()).toMatchObject({ ok: false, errorKind: "capture-unsupported" });
    });
    browserMock.runtime.sendMessage.mockRejectedValue(new Error("worker stopped"));
    act(() => result.current.retryCapabilities());
    await waitFor(() => expect(result.current.capabilityError).toContain("无法确认"));
    expect(saves()).toHaveLength(0);
  });

  it("does not treat an unavailable status response as proof that the page was never saved", async () => {
    wireRuntime({ GET_CLIP_STATUS: undefined });
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await waitFor(() => expect(result.current.statusError).toContain("无法判断"));
    expect(result.current.savedClip).toBeNull();
  });

  it("does not let a late history lookup erase a confirmed successful save", async () => {
    let resolveStatus!: (value: null) => void;
    wireRuntime({
      GET_CLIP_STATUS: new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    });
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    await act(async () => {
      await result.current.save();
    });
    await act(async () => resolveStatus(null));
    expect(result.current.savedClip?.memoUrl).toBe("https://memos.example.com/memos/1");
  });

  it("shows local restoration failures and recovers on the next successful write", async () => {
    browserMock.storage.local.get.mockRejectedValueOnce(new Error("storage unavailable"));
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    expect(result.current.storageError).toContain("无法恢复");
    await act(async () => result.current.start("STAR"));
    expect(result.current.storageError).toBeNull();
    expect(result.current.draft).not.toBeNull();
  });

  it("preserves Pick up background when refreshing the published reply", async () => {
    browserMock.tabs.query.mockResolvedValue([{ id: 4, url: xUrl }]);
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("PICK_UP"));
    await act(async () => result.current.update({}, { context: "Why this mattered" }));
    await act(async () => result.current.start("PICK_UP", true));
    expect(result.current.draft?.capture.context).toBe("Why this mattered");
    expect(result.current.draft?.capture.comment).toBe("My published reply");
  });

  it("persists the operation before sending and never includes tokens in draft storage", async () => {
    const initialRuntime = browserMock.runtime.sendMessage.getMockImplementation()!;
    browserMock.runtime.sendMessage.mockImplementation(async (message: unknown) => {
      const request = message as { type: string; saveRequestId?: string };
      if (request.type === "SAVE_MEMO") {
        const stored = await browserMock.storage.local.get(null);
        expect(Object.values(stored)).toContainEqual(
          expect.objectContaining({ operation: expect.objectContaining({ requestId: request.saveRequestId }) }),
        );
        expect(JSON.stringify(stored)).not.toContain("accessToken");
      }
      return initialRuntime(message);
    });
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    await act(async () => {
      expect((await result.current.save()).ok).toBe(true);
    });
  });

  it("blocks the request if durable storage fails and preserves editable input", async () => {
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    browserMock.storage.local.set.mockRejectedValue(new Error("quota exceeded"));
    await act(async () => {
      expect(await result.current.save()).toEqual({ ok: false, errorKind: "storage-error" });
    });
    expect(saves()).toHaveLength(0);
    expect(result.current.storageError).toContain("未能写入");
    expect(result.current.awaitingConfirmation).toBe(false);
    act(() => result.current.update({}, { comment: "Still editable" }));
    expect(result.current.draft?.capture.comment).toBe("Still editable");
  });

  it("restores an ambiguous save after closing, retries the same ID, and allocates a new ID only after success", async () => {
    wireRuntime({ SAVE_MEMO: { ok: false, errorKind: "timeout" } });
    const first = renderHook(useReadyClipper);
    await waitReady(first.result);
    await act(async () => first.result.current.start("STAR"));
    await act(async () => {
      await first.result.current.save();
    });
    const firstId = saves()[0]?.saveRequestId;
    expect(first.result.current.awaitingConfirmation).toBe(true);
    act(() => first.result.current.update({}, { comment: "Must not mutate an ambiguous request" }));
    expect(first.result.current.draft?.capture.comment).toBe("");
    first.unmount();
    wireRuntime();
    const reopened = renderHook(useReadyClipper);
    await waitReady(reopened.result);
    expect(reopened.result.current.awaitingConfirmation).toBe(true);
    await act(async () => {
      await reopened.result.current.save();
    });
    expect(saves()[1]?.saveRequestId).toBe(firstId);
    expect(reopened.result.current.awaitingConfirmation).toBe(false);
    await act(async () => {
      await reopened.result.current.save();
    });
    expect(saves()[2]?.saveRequestId).not.toBe(firstId);
  });

  it("unlocks editing after a definite validation failure", async () => {
    wireRuntime({ SAVE_MEMO: { ok: false, errorKind: "invalid-content" } });
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.draft?.operation).toBeNull();
    act(() => result.current.update({ original: "Repaired source" }));
    expect(result.current.draft?.original).toBe("Repaired source");
  });

  it("marks resumed requests as retries and requires an explicit new save after a missing record", async () => {
    wireRuntime({ SAVE_MEMO: { ok: false, errorKind: "timeout" } });
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    await act(async () => {
      await result.current.save();
    });
    expect(saves()[0]?.saveIsRetry).toBe(false);
    const previousId = saves()[0]?.saveRequestId;
    wireRuntime({ SAVE_MEMO: { ok: false, errorKind: "not-found" } });
    await act(async () => {
      await result.current.save();
    });
    expect(saves()[1]).toMatchObject({ saveIsRetry: true, saveRequestId: previousId });
    expect(result.current.notice).toContain("请先检查历史");
    expect(result.current.draft?.operation).toBeNull();
    wireRuntime();
    await act(async () => {
      await result.current.save();
    });
    expect(saves()[2]?.saveIsRetry).toBe(false);
    expect(saves()[2]?.saveRequestId).not.toBe(previousId);
  });

  it("blocks editing and duplicate sends while a save is in flight", async () => {
    let resolveSave!: (value: unknown) => void;
    wireRuntime({
      SAVE_MEMO: new Promise((resolve) => {
        resolveSave = resolve;
      }),
    });
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.save();
    });
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(result.current.busy).toBe(true);
    act(() => result.current.update({ original: "Must not change" }, { comment: "Must not change" }));
    await act(async () => {
      expect((await result.current.save()).ok).toBe(false);
    });
    expect(result.current.draft?.original).not.toBe("Must not change");
    expect(saves()).toHaveLength(1);
    await act(async () => {
      resolveSave({ ok: true, webUrl: "https://memos.example.com/memos/1" });
      await pending;
    });
    expect(result.current.busy).toBe(false);
  });

  it("uses the last successful visibility and persists it only after success", async () => {
    seedStorage({ [LAST_VISIBILITY_KEY]: "PUBLIC" });
    const { result } = renderHook(useReadyClipper);
    await waitReady(result);
    await act(async () => result.current.start("STAR"));
    expect(result.current.draft?.visibility).toBe("PUBLIC");
    act(() => result.current.update({ visibility: "PROTECTED" }));
    await act(async () => {
      await result.current.save();
    });
    expect(browserMock.storage.local.set).toHaveBeenCalledWith({ [LAST_VISIBILITY_KEY]: "PROTECTED" });
  });

  it("returns not-configured without a connection", async () => {
    const { result } = renderHook(() => useClipper(null, null));
    await act(async () => {
      expect(await result.current.save()).toEqual({ ok: false, errorKind: "not-configured" });
    });
  });
});
