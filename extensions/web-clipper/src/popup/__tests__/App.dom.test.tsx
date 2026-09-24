import { beforeEach, describe, expect, it } from "vitest";
import type { ClipSaveStatus } from "@/lib/clip-records";
import type { PopupState } from "@/lib/popup-state";
import { App } from "@/popup/App";
import { browserMock } from "@/test/browser-mock";
import { fireEvent, renderWithUser, screen, waitFor } from "@/test/render";

const capture = {
  title: "Hello World",
  url: "https://example.com/post",
  selectionHtml: "<p>Captured body</p>",
};
const identity = { userId: "user_123", displayName: "Steven Li", imageUrl: "https://img.example.com/a.png" };
const readyState: PopupState = {
  status: "ready",
  source: "usememos",
  identity,
  template: null,
  instanceUrl: "https://memos.example.com",
  version: "0.29.1",
  updatedAt: 1,
};

function wireSaveResult(
  result: unknown = { ok: true, webUrl: "https://memos.example.com/memos/1" },
  popupState: PopupState = readyState,
  savedClip: ClipSaveStatus | null = null,
) {
  browserMock.runtime.sendMessage.mockImplementation(async (msg: unknown) => {
    const type = (msg as { type: string }).type;
    if (type === "GET_POPUP_STATE") return popupState;
    if (type === "GET_CAPTURE_CAPABILITIES") return { ok: true, supported: true, contentMaxBytes: 8192 };
    if (type === "GET_CLIP_STATUS") return savedClip;
    if (type === "GET_MEMO_TAGS") return { ok: true, tags: ["阅读", "项目/灵感"] };
    if (type === "SAVE_MEMO") return result;
    return undefined;
  });
  browserMock.tabs.query.mockResolvedValue([{ id: 7, title: "Hello World", url: "https://example.com/post" }]);
  browserMock.scripting.executeScript.mockResolvedValue([{ result: capture }]);
}

describe("App — signed-out", () => {
  beforeEach(() => {
    browserMock.tabs.query.mockResolvedValue([{ id: 7 }]);
    browserMock.scripting.executeScript.mockResolvedValue([{ result: capture }]);
    wireSaveResult(undefined, { status: "signed-out", source: null, updatedAt: 1 });
  });

  it("opens settings so the user can choose a connection method", async () => {
    const { user } = renderWithUser(<App />);
    expect(await screen.findByText(/choose how to connect/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /open settings/i }));
    await waitFor(() => expect(browserMock.runtime.openOptionsPage).toHaveBeenCalled());
  });
});

describe("App — signed-in, no connection", () => {
  beforeEach(() => {
    browserMock.tabs.query.mockResolvedValue([{ id: 7 }]);
    browserMock.scripting.executeScript.mockResolvedValue([{ result: capture }]);
    wireSaveResult(undefined, { status: "disconnected", source: "usememos", identity, template: null, updatedAt: 1 });
  });

  it("prompts to connect and opens the options page", async () => {
    const { user } = renderWithUser(<App />);
    expect(await screen.findByText(/connect your memos instance to start clipping/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /open settings/i }));
    await waitFor(() => expect(browserMock.runtime.openOptionsPage).toHaveBeenCalled());
  });
});

describe("App — signed-in, unsupported version", () => {
  beforeEach(() => {
    browserMock.tabs.query.mockResolvedValue([{ id: 7 }]);
    browserMock.scripting.executeScript.mockResolvedValue([{ result: capture }]);
    wireSaveResult(undefined, {
      status: "unsupported",
      source: "usememos",
      identity,
      template: null,
      instanceUrl: "https://memos.example.com",
      version: "0.25.9",
      updatedAt: 1,
    });
  });

  it("gates with an upgrade guide link", async () => {
    renderWithUser(<App />);
    expect(await screen.findByText(/unsupported memos version/i)).toBeInTheDocument();
    const upgrade = screen.getByRole("link", { name: /how to upgrade memos/i });
    expect(upgrade).toHaveAttribute("href", "https://www.usememos.com/docs/operations/upgrade");
  });
});

describe("App — manual capture workspace", () => {
  beforeEach(() => wireSaveResult());

  async function startStar() {
    const rendered = renderWithUser(<App />);
    const star = await screen.findByRole("button", { name: "Star" });
    await waitFor(() => expect(star).toBeEnabled());
    await rendered.user.click(star);
    await screen.findByRole("textbox", { name: "我的思考" });
    return rendered;
  }

  it("opens with two actions and reads no page content", async () => {
    renderWithUser(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Star" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Pick up" })).toBeEnabled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("uses every Enter variant for newlines and only saves with an explicit action", async () => {
    const { user } = await startStar();
    const thought = screen.getByRole("textbox", { name: "我的思考" });
    await user.type(thought, "first{Enter}second");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(thought).toHaveValue("first\nsecond\n\n");
    fireEvent.keyDown(thought, { key: "Enter", ctrlKey: true, isComposing: true });
    expect(thought).toHaveValue("first\nsecond\n\n");
    expect(browserMock.runtime.sendMessage.mock.calls.some(([r]) => (r as { type: string }).type === "SAVE_MEMO")).toBe(false);
    await user.click(screen.getByRole("tab", { name: "原内容" }));
    await user.click(screen.getByRole("button", { name: "编辑原内容" }));
    await user.click(screen.getByRole("textbox", { name: "原内容" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(browserMock.runtime.sendMessage.mock.calls.some(([r]) => (r as { type: string }).type === "SAVE_MEMO")).toBe(false);
    await user.click(screen.getByRole("button", { name: /save to memos/i }));
    await screen.findByRole("button", { name: "另存一条" });
  });

  it("switches full-width views without losing edits or leaving collapsed source content", async () => {
    const { user, container } = await startStar();
    const thought = screen.getByRole("textbox", { name: "我的思考" });
    expect(
      screen.getByRole("region", { name: "标签管理" }).compareDocumentPosition(thought) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.type(thought, "My thought");
    await user.click(screen.getByRole("tab", { name: "原内容" }));
    expect(screen.getByText("Captured body")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "编辑原内容" }));
    await user.clear(screen.getByRole("textbox", { name: "原内容" }));
    await user.type(screen.getByRole("textbox", { name: "原内容" }), "<details><summary>Source</summary><p>Full source</p></details>");
    await user.click(screen.getByRole("tab", { name: "保存预览" }));
    expect(screen.getByText("Full source")).toBeVisible();
    expect(container.querySelector("details")).toBeNull();
    expect(screen.getByText("My thought")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "我的产出" }));
    expect(screen.getByRole("textbox", { name: "我的思考" })).toHaveValue("My thought");
  });

  it("keeps an explicitly bound source when the editor itself is the active tab", async () => {
    browserMock.tabs.query.mockResolvedValue([{ id: 99, url: "chrome-extension://test-id/src/popup/index.html" }]);
    const { user } = renderWithUser(<App source={{ id: 7, url: capture.url }} />);
    const star = await screen.findByRole("button", { name: "Star" });
    await waitFor(() => expect(star).toBeEnabled());
    await user.click(star);
    await screen.findByRole("textbox", { name: "我的思考" });
    expect(browserMock.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7 } }));
  });

  it("Star captures an ordinary website only on click and saves thoughts first", async () => {
    const { user } = await startStar();
    await user.type(screen.getByRole("textbox", { name: "我的思考" }), "This is the insight I noticed.");
    await user.click(screen.getByRole("button", { name: /save to memos/i }));
    await screen.findByRole("button", { name: "另存一条" });
    const save = browserMock.runtime.sendMessage.mock.calls
      .map(([request]) => request as Record<string, any>)
      .find((r) => r.type === "SAVE_MEMO")!;
    expect(save.content.indexOf("This is the insight")).toBeLessThan(save.content.indexOf("Captured body"));
    expect(save.clip.capture).toMatchObject({ kind: "STAR", platform: "WEB", comment: "This is the insight I noticed." });
    expect(save.tags).toEqual(["star"]);
    expect(screen.getByRole("link", { name: /open memo/i })).toHaveAttribute("href", "https://memos.example.com/memos/1");
  });

  it("saves selected and new independent tags and renders the final Markdown preview", async () => {
    const { user } = await startStar();
    expect(screen.getByRole("button", { name: "移除标签 star" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /添加标签/ }));
    await user.click(await screen.findByRole("option", { name: "阅读" }));
    await user.click(screen.getByRole("button", { name: /添加标签/ }));
    await user.type(screen.getByRole("combobox", { name: "搜索或新建标签" }), "自己的想法{Enter}");
    await user.type(screen.getByRole("textbox", { name: "我的思考" }), "**值得回顾**");
    await user.click(screen.getByRole("tab", { name: "保存预览" }));
    expect(screen.getByRole("heading", { name: "我的思考" })).toBeInTheDocument();
    expect(screen.getByText("值得回顾").tagName).toBe("STRONG");
    await user.click(screen.getByRole("button", { name: /save to memos/i }));
    await screen.findByRole("button", { name: "另存一条" });
    const save = browserMock.runtime.sendMessage.mock.calls
      .map(([request]) => request as Record<string, unknown>)
      .find((r) => r.type === "SAVE_MEMO")!;
    expect(save.tags).toEqual(["star", "阅读", "自己的想法"]);
    expect(String(save.content)).not.toContain("#star");
  });

  it("rejects Pick up away from an X detail page without injecting scripts", async () => {
    const { user } = renderWithUser(<App />);
    const pickup = await screen.findByRole("button", { name: "Pick up" });
    await waitFor(() => expect(pickup).toBeEnabled());
    await user.click(pickup);
    expect(await screen.findByText(/X.*详情页.*Pick up/)).toBeInTheDocument();
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("retains a thought when closed and reopened without another extraction", async () => {
    const { user, unmount } = await startStar();
    await user.type(screen.getByRole("textbox", { name: "我的思考" }), "Keep this draft");
    await waitFor(() => expect(browserMock.storage.local.set).toHaveBeenCalled());
    unmount();
    browserMock.scripting.executeScript.mockClear();
    renderWithUser(<App />);
    expect(await screen.findByRole("textbox", { name: "我的思考" })).toHaveValue("Keep this draft");
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("keeps image failures visible after successful note creation", async () => {
    wireSaveResult({ ok: true, webUrl: "https://memos.example.com/memos/1", failedImages: 2 });
    const { user } = await startStar();
    await user.click(screen.getByRole("button", { name: /save to memos/i }));
    expect(await screen.findByText(/2 images weren't attached/i)).toBeInTheDocument();
  });

  it("shows persistent image failure details safely and clears them when editing", async () => {
    const embedded = `data:image/png;base64,${"a".repeat(300)}`;
    wireSaveResult({
      ok: true,
      webUrl: "https://memos.example.com/memos/1",
      failedImages: 2,
      failedImageDetails: [
        { url: "https://example.com/missing.png", reason: "图片下载失败" },
        { url: embedded, reason: "图片超过大小限制" },
      ],
    });
    const { user } = await startStar();
    await user.click(screen.getByRole("button", { name: /save to memos/i }));
    await user.click(await screen.findByText("未转存的图片（已保留原链接）"));
    expect(screen.getByText("图片下载失败")).toBeVisible();
    expect(screen.getByTitle("https://example.com/missing.png").tagName).toBe("P");
    const embeddedLabel = screen.getByTitle(embedded);
    expect(embeddedLabel.textContent!.length).toBeLessThan(180);
    expect(embeddedLabel).not.toHaveAttribute("href");
    expect(screen.getByRole("button", { name: "另存一条" })).toBeEnabled();
    expect(screen.getByText("图片下载失败")).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "我的思考" }), "Updated thought");
    expect(screen.queryByText("未转存的图片（已保留原链接）")).not.toBeInTheDocument();
    expect(screen.queryByText(/2 images weren't attached/i)).not.toBeInTheDocument();
  });

  it("clears image failures when starting another capture mode", async () => {
    wireSaveResult({
      ok: true,
      webUrl: "https://memos.example.com/memos/1",
      failedImages: 1,
      failedImageDetails: [{ url: "https://example.com/missing.png", reason: "图片下载失败" }],
    });
    const { user } = await startStar();
    await user.click(screen.getByRole("button", { name: /save to memos/i }));
    await screen.findByText("未转存的图片（已保留原链接）");
    await user.click(screen.getByRole("button", { name: "Pick up" }));
    expect(screen.queryByText("未转存的图片（已保留原链接）")).not.toBeInTheDocument();
    expect(screen.queryByText(/weren't attached/i)).not.toBeInTheDocument();
  });

  it("retries the same save after a timeout without recapturing", async () => {
    wireSaveResult({ ok: false, errorKind: "timeout" });
    const { user } = await startStar();
    await user.click(screen.getByRole("button", { name: /save to memos/i }));
    expect(await screen.findByText(/your instance timed out/i)).toBeInTheDocument();
    wireSaveResult();
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await screen.findByRole("button", { name: "另存一条" });
    const saves = browserMock.runtime.sendMessage.mock.calls
      .map(([r]) => r as Record<string, unknown>)
      .filter((r) => r.type === "SAVE_MEMO");
    expect(saves).toHaveLength(2);
    expect(saves[0]!.saveRequestId).toBe(saves[1]!.saveRequestId);
    expect(browserMock.scripting.executeScript).toHaveBeenCalledTimes(1);
  });

  it("preserves the editor and disables saving when cached auth is invalidated", async () => {
    const { user } = await startStar();
    await user.type(screen.getByRole("textbox", { name: "我的思考" }), "Important thought");
    wireSaveResult(undefined, { status: "signed-out", source: null, updatedAt: 2 });
    await browserMock.runtime.onMessage.emit({ type: "AUTH_CHANGED" });
    await waitFor(() => expect(screen.getByRole("button", { name: /save to memos/i })).toBeDisabled());
    expect(screen.getByRole("textbox", { name: "我的思考" })).toHaveValue("Important thought");
  });
});
