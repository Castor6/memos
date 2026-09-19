import type { Definition, Image, ImageReference, Link, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { FILE_TITLE, REFERENCE_TITLE } from "@/lib/inline-media";

const escapeLabel = (value: string) => value.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ");
const titleSuffix = (title?: string | null) => (title ? ` "${title.replace(/["\\]/g, "\\$&")}"` : "");

/** Make links portable, allowing only ordinary file, web and email destinations. */
export function exportURL(value: string, origin: string): string {
  if (value.startsWith("#")) return value;
  try {
    const url = new URL(value, origin);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href.replace(/[<>]/g, (c) => encodeURIComponent(c)) : "";
  } catch {
    return "";
  }
}

/** Export only body content; do not append legacy attachments or mutate the memo. */
export function exportMemoMarkdown(content: string, origin: string): string {
  const tree = fromMarkdown(content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const definitions = new Map<string, Definition>();
  const collect = (node: RootContent | typeof tree) => {
    if (node.type === "definition") definitions.set(node.identifier, node);
    if ("children" in node) node.children.forEach(collect);
  };
  collect(tree);
  const media = (node: Image | ImageReference, url: string, title?: string | null) => {
    const target = exportURL(url, origin);
    const isFile = title?.startsWith(FILE_TITLE);
    const isLink = title === REFERENCE_TITLE || (isFile && !title?.slice(FILE_TITLE.length).startsWith("image/"));
    const label = escapeLabel(node.alt || (isLink ? "文件" : "图片"));
    return `${isLink ? "" : "!"}[${label}](<${target}>${titleSuffix(title?.startsWith("memos:") ? null : title)})`;
  };
  const rewrite = (node: RootContent | typeof tree): string => {
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? content.length;
    if (node.type === "image") return media(node, node.url, node.title);
    if (node.type === "imageReference") {
      const definition = definitions.get(node.identifier);
      if (definition) return media(node, definition.url, definition.title);
    }
    if (node.type === "definition") {
      return `[${node.label || node.identifier}]: <${exportURL(node.url, origin)}>${titleSuffix(node.title)}`;
    }
    let result = "";
    let cursor = start;
    if ("children" in node) {
      for (const child of node.children) {
        const childStart = child.position?.start.offset;
        const childEnd = child.position?.end.offset;
        if (childStart === undefined || childEnd === undefined) continue;
        result += content.slice(cursor, childStart) + rewrite(child);
        cursor = childEnd;
      }
    }
    result += content.slice(cursor, end);
    if (node.type === "link") {
      const link = node as Link;
      const label = link.children.map(rewrite).join("");
      return `[${label}](<${exportURL(link.url, origin)}>${titleSuffix(link.title)})`;
    }
    return result;
  };
  return rewrite(tree);
}

export function memoExportFilename(name: string, title: string, extension: "md" | "pdf"): string {
  const base = (title || name.split("/").pop() || "memo")
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\p{Cc}/gu, "-")
    .trim()
    .slice(0, 100);
  return `${base || "memo"}.${extension}`;
}

export function downloadMemoMarkdown(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // The browser may start reading the blob after click returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
