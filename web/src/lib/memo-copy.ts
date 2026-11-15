import type { Nodes, RootContent } from "mdast";
import { isGridImage, parseMarkdown } from "@/lib/memo-image-grid";

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** The editor stores &, <, > and empty lines as entities; copied text should read as typed. */
const decodeEntities = (value: string) => value.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity]);

const isBlankText = (node: Nodes) => node.type === "break" || (node.type === "text" && !node.value.replace(/ /g, "").trim());

const isImageOnlyParagraph = (node: RootContent) =>
  node.type === "paragraph" &&
  node.children.some((child) => child.type === "image" && isGridImage(child)) &&
  node.children.every((child) => (child.type === "image" && isGridImage(child)) || isBlankText(child));

const isEmptyParagraph = (node: RootContent) => node.type === "paragraph" && node.children.every(isBlankText);

/** Render one block from its source, turning hard breaks into newlines and optionally dropping images. */
function renderBlock(content: string, block: RootContent, stripImages: boolean): string {
  const start = block.position?.start.offset ?? 0;
  const end = block.position?.end.offset ?? start;
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: Nodes, inLink: boolean) => {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (from === undefined || to === undefined) return;
    if (node.type === "code" || node.type === "inlineCode" || node.type === "html") {
      edits.push({ start: from, end: to, text: content.slice(from, to) });
      return;
    }
    if (node.type === "break") {
      edits.push({ start: from, end: to, text: "\n" });
      return;
    }
    if (node.type === "image" && stripImages && !inLink && isGridImage(node)) {
      edits.push({ start: from, end: to, text: "" });
      return;
    }
    if ("children" in node)
      for (const child of node.children) visit(child, inLink || node.type === "link" || node.type === "linkReference");
  };
  visit(block, false);
  edits.sort((a, b) => a.start - b.start);
  let result = "";
  let cursor = start;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    result += decodeEntities(content.slice(cursor, edit.start)) + edit.text;
    cursor = edit.end;
  }
  return result + decodeEntities(content.slice(cursor, end));
}

/**
 * Text for "Copy content": one newline per Enter instead of Markdown's blank
 * line between paragraphs, intentional empty lines kept, other Markdown left
 * as written. Image-grid memos copy without their images.
 */
export function memoCopyText(content: string, options: { stripImages?: boolean } = {}): string {
  const stripImages = Boolean(options.stripImages);
  const lines: string[] = [];
  for (const block of parseMarkdown(content).children) {
    if (stripImages && isImageOnlyParagraph(block)) continue;
    lines.push(isEmptyParagraph(block) ? "" : renderBlock(content, block, stripImages).replace(/[ \t]+$/gm, ""));
  }
  return lines.join("\n");
}
