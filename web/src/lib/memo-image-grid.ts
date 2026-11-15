import type { Image, Nodes, Parent, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { FILE_TITLE } from "@/lib/inline-media";
import type { Attachment } from "@/types/proto/api/v1/attachment_service_pb";
import { getAttachmentThumbnailUrl, getAttachmentUrl, isImage } from "@/utils/attachment";
import { resolveInlineAttachmentUrl } from "@/utils/inline-attachment";

export interface MemoGridImage {
  key: string;
  /** Full-size display URL used by the preview dialog. */
  src: string;
  /** Smaller URL for grid tiles; equals src for non-attachment images. */
  thumbnail: string;
  alt: string;
}

export const parseMarkdown = (content: string): Root =>
  fromMarkdown(content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });

/** Inline Memos image files and plain Markdown images are grid images; videos, files and references are not. */
export const isGridImage = (node: Image) => !node.title?.startsWith("memos:") || node.title.startsWith(`${FILE_TITLE}image/`);

/** Whether a paragraph has nothing left besides the given removed images and whitespace. */
const onlyImages = (node: Parent, removed: Set<Nodes>) =>
  node.children.length > 0 &&
  node.children.some((child) => removed.has(child)) &&
  node.children.every((child) => removed.has(child) || child.type === "break" || (child.type === "text" && !child.value.trim()));

/** Collect top-level-safe source ranges for images outside links, removing image-only paragraphs whole. */
export function collectImageRanges(content: string, tree: Root = parseMarkdown(content)) {
  const images: Image[] = [];
  const ranges: [number, number][] = [];
  const visit = (node: Nodes, parent: Parent | null) => {
    if (node.type === "link" || node.type === "linkReference") return;
    if (node.type === "image" && isGridImage(node)) {
      images.push(node);
      return;
    }
    if (!("children" in node)) return;
    const before = images.length;
    for (const child of node.children) visit(child, node);
    const found = new Set<Nodes>(images.slice(before));
    if (!found.size || node.type !== "paragraph") return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (parent?.type === "root" && start !== undefined && end !== undefined && onlyImages(node, found)) {
      // Swallow the following blank-line separator so no gap is left between neighbours.
      const trailing = /^\n*/.exec(content.slice(end))?.[0].length ?? 0;
      ranges.push([start, end + trailing]);
      return;
    }
    for (const image of found) {
      if (image.position?.start.offset !== undefined && image.position.end.offset !== undefined)
        ranges.push([image.position.start.offset, image.position.end.offset]);
    }
  };
  visit(tree, null);
  return { images, ranges: ranges.sort((a, b) => a[0] - b[0]) };
}

export const removeRanges = (content: string, ranges: [number, number][]) => {
  let result = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue;
    result += content.slice(cursor, start);
    cursor = end;
  }
  return result + content.slice(cursor);
};

const attachmentPath = (attachment: Attachment) => `/file/${attachment.name}/${encodeURIComponent(attachment.filename)}`;

const findAttachment = (src: string, attachments: readonly Attachment[], origin: string) => {
  try {
    const url = new URL(src, origin);
    if (url.origin !== origin) return attachments.find((item) => item.externalLink === src);
    return attachments.find((item) => url.pathname === attachmentPath(item) || url.pathname === `/file/${item.name}/${item.filename}`);
  } catch {
    return undefined;
  }
};

export const isReferenced = (content: string, attachment: Attachment) =>
  content.includes(attachment.name) || content.includes(getAttachmentUrl(attachment));

/**
 * Split a memo into its text body and the images shown in the bottom grid.
 * Inline images come first in document order, followed by unreferenced image
 * attachments. The stored content is never modified.
 */
export function splitMemoImages(
  content: string,
  attachments: readonly Attachment[],
  origin = window.location.origin,
): { body: string; images: MemoGridImage[] } {
  const { images: nodes, ranges } = collectImageRanges(content);
  const images: MemoGridImage[] = nodes.map((node, index) => {
    const src = resolveInlineAttachmentUrl(node.url, attachments, origin);
    const attachment = findAttachment(node.url, attachments, origin);
    return {
      key: `${index}:${node.url}`,
      src,
      thumbnail: attachment ? getAttachmentThumbnailUrl(attachment) : src,
      alt: node.alt || attachment?.filename || "图片",
    };
  });
  for (const attachment of attachments) {
    if (!isImage(attachment.type) || isReferenced(content, attachment)) continue;
    images.push({
      key: attachment.name,
      src: getAttachmentUrl(attachment),
      thumbnail: getAttachmentThumbnailUrl(attachment),
      alt: attachment.filename,
    });
  }
  return { body: removeRanges(content, ranges), images };
}
