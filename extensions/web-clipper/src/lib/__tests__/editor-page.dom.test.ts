import { describe, expect, it } from "vitest";
import { captureSourceKey, findEditorSource, openClipEditor, readEditorSource } from "@/lib/editor-page";
import { browserMock } from "@/test/browser-mock";

const source = { id: 7, url: "https://example.com/post?item=1#section" };
const entry = "chrome-extension://test-id/src/popup/index.html";
const editorUrl = (id = 7) => `${entry}?${new URLSearchParams({ sourceTab: String(id), sourceUrl: source.url })}`;

describe("independent editor source binding", () => {
  it("opens a full tab carrying source metadata without reading the page body", async () => {
    await openClipEditor(source);
    expect(browserMock.tabs.create).toHaveBeenCalledWith({ url: editorUrl(), openerTabId: 7 });
    expect(readEditorSource(new URL(editorUrl()).search)).toEqual(source);
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("reuses one editor across source tabs and windows to avoid competing draft writers", async () => {
    browserMock.tabs.query.mockResolvedValue([{ id: 99, windowId: 3, url: editorUrl(2) }]);
    await openClipEditor(source);
    expect(browserMock.tabs.update).toHaveBeenCalledWith(99, { active: true });
    expect(browserMock.windows.update).toHaveBeenCalledWith(3, { focused: true });
    expect(browserMock.tabs.create).not.toHaveBeenCalled();
  });

  it("does not create an editor of the editor when clicked from the work page", async () => {
    await openClipEditor({ id: 99, url: editorUrl() });
    expect(browserMock.tabs.update).toHaveBeenCalledWith(99, { active: true });
    expect(browserMock.tabs.create).not.toHaveBeenCalled();
  });

  it("finds the reopened source without ever choosing the active editor", async () => {
    browserMock.tabs.get.mockRejectedValue(new Error("tab closed"));
    browserMock.tabs.query.mockResolvedValue([
      { id: 99, url: editorUrl() },
      { id: 8, url: source.url },
    ]);
    await expect(findEditorSource(source)).resolves.toEqual({ id: 8, url: source.url });
  });

  it("reuses an editor that is still loading after a rapid second toolbar click", async () => {
    browserMock.tabs.query.mockResolvedValue([{ id: 99, url: "", pendingUrl: editorUrl() }]);
    await openClipEditor(source);
    expect(browserMock.tabs.update).toHaveBeenCalledWith(99, { active: true });
    expect(browserMock.tabs.create).not.toHaveBeenCalled();
  });

  it("rejects a navigated or closed source if no matching page remains", async () => {
    browserMock.tabs.get.mockResolvedValue({ id: 7, url: "https://example.com/another", title: "Another" });
    browserMock.tabs.query.mockResolvedValue([{ id: 99, url: editorUrl() }]);
    await expect(findEditorSource(source)).rejects.toThrow("当前草稿已保留");
  });

  it("keeps existing X draft keys and rejects invalid source metadata", () => {
    expect(captureSourceKey("https://twitter.com/me/status/300/photo/1")).toBe("https://x.com/me/status/300");
    for (const search of [
      "",
      "?sourceTab=-1&sourceUrl=https://example.com",
      "?sourceTab=7&sourceUrl=chrome://settings",
      "?sourceTab=7&sourceUrl=https://",
    ]) {
      expect(readEditorSource(search)).toBeNull();
    }
  });
});
