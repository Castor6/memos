import { useEffect, useState } from "react";
import browser from "webextension-polyfill";
import { extractArticle } from "@/lib/article";
import { htmlToMarkdown, toQuotedMarkdown } from "@/lib/format";
import { normalizeImageSources } from "@/lib/image-sources";
import type { CapturePayload } from "@/lib/messages";

/** The raw capture, template-independent — composed into the editor prefill once the template loads. */
export type PageCapture = {
  title: string;
  url: string;
  description?: string;
  /** The selection as quoted Markdown ("" when there's no selection). */
  selectionMarkdown: string;
  /** The page's main content as Markdown ("" when there's a selection, or no article was found). */
  articleMarkdown: string;
  /** Absolute image URLs from the selection, to upload as attachments. */
  images: string[];
  /** Why capture degraded, so the popup can explain a link-only/manual result. */
  fallbackReason?: CaptureFallbackReason;
};

export type CaptureFallbackReason = "no-article" | "no-description" | "restricted" | "timed-out" | "unavailable";

/** Keeps total capture comfortably inside the MVP's five-second interaction budget. */
export const TAB_QUERY_TIMEOUT_MS = 750;
export const PAGE_INJECTION_TIMEOUT_MS = 2_000;

/**
 * Ceiling on the serialized page handed back for extraction. Past this the page is an outlier —
 * an infinite feed or an embedded document viewer — where extraction would cost more than the
 * link-and-description fallback is worth. Measured after non-content nodes are stripped.
 */
export const MAX_DOCUMENT_HTML_CHARS = 5_000_000;

class CaptureTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CaptureTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs INSIDE the page via scripting.executeScript, so it must be fully self-contained (Chrome
 * serializes the function; it can't reference imports). Injected only after the user requests capture, it
 * works even when the tab's content script is stale (tab opened before an extension update).
 */
function capturePage(maxDocumentHtmlChars: number): CapturePayload {
  const selection = window.getSelection();
  let selectionHtml = "";
  const images: string[] = [];
  if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
    // Keep this self-contained: Chrome serializes only `capturePage`, not imported helpers.
    const inlineTags = new Set([
      "A",
      "ABBR",
      "B",
      "BDI",
      "BDO",
      "CITE",
      "CODE",
      "DATA",
      "DEL",
      "DFN",
      "EM",
      "I",
      "INS",
      "KBD",
      "MARK",
      "Q",
      "RUBY",
      "S",
      "SAMP",
      "SMALL",
      "SPAN",
      "STRONG",
      "SUB",
      "SUP",
      "TIME",
      "U",
      "VAR",
    ]);
    const range = selection.getRangeAt(0);
    let ancestor =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement;
    let wrapped: Node = range.cloneContents();
    while (ancestor && inlineTags.has(ancestor.tagName)) {
      const clone = ancestor.cloneNode(false) as Element;
      clone.appendChild(wrapped);
      wrapped = clone;
      ancestor = ancestor.parentElement;
    }
    const container = document.createElement("div");
    container.appendChild(wrapped);
    // Keep image nodes in place, resolving against the live page's base before serialization.
    const selectedImages = Array.from(document.querySelectorAll("img")).filter((img) => range.intersectsNode(img));
    container.querySelectorAll("img").forEach((img, index) => {
      if (selectedImages[index]?.currentSrc) img.setAttribute("src", selectedImages[index].currentSrc);
      for (const attribute of ["src", "data-src", "data-original", "data-lazy-src", "data-url"]) {
        const raw = img.getAttribute(attribute);
        if (!raw?.trim()) continue;
        try {
          img.setAttribute(attribute, new URL(raw, document.baseURI).href);
        } catch {
          /* Retain for inert normalization. */
        }
      }
    });
    const base = document.createElement("base");
    base.href = document.baseURI;
    selectionHtml = base.outerHTML + container.innerHTML;
  }
  const normalized = (value: string | null | undefined) => value?.replace(/\s+/g, " ").trim() || undefined;
  const meta = (s: string) => normalized(document.querySelector<HTMLMetaElement>(s)?.content);
  const firstReadableParagraph = () => {
    for (const paragraph of document.querySelectorAll("p")) {
      if (
        paragraph.hidden ||
        paragraph.getAttribute("aria-hidden") === "true" ||
        paragraph.closest('nav,header,footer,aside,menu,form,dialog,[role="navigation"],[aria-hidden="true"]')
      ) {
        continue;
      }
      const style = getComputedStyle(paragraph);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const text = normalized(paragraph.textContent);
      if (text && text.length >= 40) return text;
    }
    return undefined;
  };
  const description = meta('meta[property="og:description"]') ?? meta('meta[name="description"]') ?? firstReadableParagraph();

  // With no selection the popup extracts the page's main content instead, which needs the DOM as
  // the user sees it — after client-side rendering, which the raw HTTP response wouldn't show.
  // Serialize a stripped clone: scripts and other non-content nodes are most of a modern page's
  // bytes and none of its meaning, and the result crosses a message boundary.
  let documentHtml: string | undefined;
  if (!selectionHtml) {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    const originals = Array.from(document.querySelectorAll("img"));
    clone.querySelectorAll("img").forEach((img, index) => {
      if (originals[index]?.currentSrc) img.setAttribute("src", originals[index].currentSrc);
    });
    for (const element of clone.querySelectorAll("script,noscript,template,iframe,object,embed,canvas,svg")) {
      element.remove();
    }
    const serialized = `<!doctype html>${clone.outerHTML}`;
    if (serialized.length <= maxDocumentHtmlChars) documentHtml = serialized;
  }

  return {
    title: document.title,
    url: location.href,
    selectionHtml: selectionHtml || undefined,
    description,
    images,
    documentHtml,
  };
}

/**
 * Names what the clip is missing, so the popup can say so instead of quietly handing back less than
 * the user expected. A captured article is the complete result and reports nothing; a selection is
 * complete on its own terms and is judged only on whether the page also had a description.
 */
function captureFallback({ hasSelection, hasArticle, description }: { hasSelection: boolean; hasArticle: boolean; description?: string }): {
  fallbackReason?: CaptureFallbackReason;
} {
  if (hasArticle) return {};
  if (!description) return { fallbackReason: "no-description" };
  return hasSelection ? {} : { fallbackReason: "no-article" };
}

export async function captureActivePage(sourceTabId?: number): Promise<PageCapture> {
  let tab: Awaited<ReturnType<typeof browser.tabs.query>>[number] | undefined;
  try {
    tab =
      sourceTabId === undefined
        ? (await withTimeout(browser.tabs.query({ active: true, currentWindow: true }), TAB_QUERY_TIMEOUT_MS))[0]
        : await withTimeout(browser.tabs.get(sourceTabId), TAB_QUERY_TIMEOUT_MS);
  } catch (error) {
    return {
      title: "",
      url: "",
      description: undefined,
      selectionMarkdown: "",
      articleMarkdown: "",
      images: [],
      fallbackReason: error instanceof CaptureTimeoutError ? "timed-out" : "unavailable",
    };
  }
  // The tab is the source of truth for title/url; the injected capture enhances it with the
  // selection + description.
  let title = tab?.title ?? "";
  let url = tab?.url ?? "";
  let description: string | undefined;
  let selectionMarkdown = "";
  if (tab?.id !== undefined) {
    try {
      const [injection] = await withTimeout(
        browser.scripting.executeScript({
          target: { tabId: tab.id },
          func: capturePage,
          args: [MAX_DOCUMENT_HTML_CHARS],
        }),
        PAGE_INJECTION_TIMEOUT_MS,
      );
      const cap = injection?.result as CapturePayload | null | undefined;
      if (cap) {
        title = title || cap.title;
        // The source can navigate between metadata lookup and injection. Never label
        // another page's content with the previous source URL.
        url = cap.url || url;
        description = cap.description;
        let selectionImages = cap.images ?? [];
        if (cap.selectionHtml) {
          const selected = new DOMParser().parseFromString(cap.selectionHtml, "text/html");
          selectionImages = [
            ...new Set([
              ...selectionImages,
              ...normalizeImageSources(selected, selected.querySelector("base[href]")?.getAttribute("href") || cap.url || url),
            ]),
          ];
          selectionMarkdown = toQuotedMarkdown(htmlToMarkdown(selected.body.innerHTML));
        }
        // A selection is an explicit instruction about what to capture — never second-guess it
        // with the whole article. Extraction only fills the gap when nothing was selected.
        const article = selectionMarkdown || !cap.documentHtml ? null : await extractArticle(cap.documentHtml, url || cap.url);
        return {
          title,
          url,
          description,
          selectionMarkdown,
          articleMarkdown: article ?? "",
          images: selectionImages,
          ...captureFallback({ hasSelection: Boolean(selectionMarkdown), hasArticle: Boolean(article), description }),
        };
      }
    } catch (error) {
      // Injection refused (chrome://, Web Store…) — the prefill degrades to a link note.
      return {
        title,
        url,
        description,
        selectionMarkdown,
        articleMarkdown: "",
        images: [],
        fallbackReason: error instanceof CaptureTimeoutError ? "timed-out" : "restricted",
      };
    }
  }
  return { title, url, description, selectionMarkdown, articleMarkdown: "", images: [], fallbackReason: "unavailable" };
}

/**
 * Extraction is opt-in. Merely mounting the popup never reads page content.
 */
export function usePageCapture(enabled = false): PageCapture | null {
  const [result, setResult] = useState<PageCapture | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void captureActivePage().then((c) => {
      if (active) setResult(c);
    });
    return () => {
      active = false;
    };
  }, [enabled]);
  return result;
}
