import browser from "webextension-polyfill";
import { normalizeClipSourceUrl } from "./clip-records";

/** Source metadata stays fixed for the lifetime of an editor, even after navigation or closure. */
export type EditorSource = { id: number; url: string };

// Keep the existing trusted entry path; only its presentation changes from popup to tab.
export const EDITOR_PATH = "src/popup/index.html";

/** Match the existing draft identity, including X aliases and tracking parameters. */
export function captureSourceKey(url: string): string {
  try {
    const parsed = new URL(url);
    const status = parsed.pathname.match(/^\/([\w]+)\/status\/(\d+)/);
    if (/^(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)$/.test(parsed.hostname) && status) {
      return `https://x.com/${status[1]}/status/${status[2]}`;
    }
  } catch {
    // Invalid URLs are rejected before extraction.
  }
  return normalizeClipSourceUrl(url);
}

/** Find the same source after its original tab was closed, without switching draft identity. */
export async function findEditorSource(source: EditorSource): Promise<EditorSource> {
  const matches = (tab: { id?: number; url?: string }) =>
    tab.id !== undefined && captureSourceKey(tab.url ?? "") === captureSourceKey(source.url);
  const original = await browser.tabs.get(source.id).catch(() => null);
  if (original && matches(original)) return { id: original.id!, url: original.url! };
  const reopened = (await browser.tabs.query({})).find(matches);
  if (reopened) return { id: reopened.id!, url: reopened.url! };
  throw new Error("原网页已关闭或切换，当前草稿已保留。请重新打开原网页后再提取。");
}

/** Read the original tab identity without treating the editor's active tab as the source. */
export function readEditorSource(search: string): EditorSource | null {
  const params = new URLSearchParams(search);
  const value = params.get("sourceTab");
  const url = params.get("sourceUrl");
  if (!value || !/^\d+$/.test(value) || !url || !/^https?:\/\//i.test(url)) return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0) return null;
  try {
    new URL(url);
    return { id, url };
  } catch {
    return null;
  }
}

/** Reuse a source's editor instead of creating competing writers for the same local draft. */
export async function openClipEditor(source: { id?: number; url?: string }): Promise<void> {
  const entry = browser.runtime.getURL(EDITOR_PATH);
  if (source.id !== undefined && source.url?.split("?")[0] === entry) {
    await browser.tabs.update(source.id, { active: true });
    return;
  }
  const params = new URLSearchParams();
  if (source.id !== undefined && source.url) {
    params.set("sourceTab", String(source.id));
    params.set("sourceUrl", source.url);
  }
  const url = `${entry}?${params}`;
  const tabs = await browser.tabs.query({});
  const existing = tabs.find((tab) => {
    const tabUrl = tab.pendingUrl || tab.url;
    if (!tabUrl || tab.id === undefined || tabUrl.split("?")[0] !== entry) return false;
    const target = readEditorSource(new URL(tabUrl).search);
    return source.url && target && captureSourceKey(target.url) === captureSourceKey(source.url);
  });
  if (existing?.id !== undefined) {
    await browser.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await browser.windows.update(existing.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url, ...(source.id === undefined ? {} : { openerTabId: source.id }) });
  }
}
