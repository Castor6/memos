import type { RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { remarkTag } from "@/utils/remark-plugins/remark-tag";

const HAN_CHARACTERS = /\p{Script=Han}/gu;
const WORDS = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*|\p{N}+/gu;
const INLINE_NODES = new Set(["strong", "emphasis", "delete", "link", "linkReference"]);

function htmlText(source: string): string {
  const document = new DOMParser().parseFromString(source, "text/html");
  document.querySelectorAll("script, style, template, img").forEach((node) => node.remove());
  document.querySelectorAll("br, summary, p, div, li").forEach((node) => node.append("\n"));
  return document.body.textContent ?? "";
}

function textFromNodes(nodes: RootContent[]): string {
  return nodes
    .map((node): string => {
      if (node.type === "text" || node.type === "inlineCode") return node.value;
      if (node.type === "code") return `\n${node.value}\n`;
      if (node.type === "html") return markdownText(htmlText(node.value));
      if ("children" in node) {
        const text = textFromNodes(node.children);
        return INLINE_NODES.has(node.type) ? text : `\n${text}\n`;
      }
      // Images include attachment cards and generated memo-reference previews.
      return " ";
    })
    .join("");
}

function markdownText(source: string): string {
  const tree = fromMarkdown(source, {
    extensions: [gfm(), { disable: { null: ["setextUnderline"] } }],
    mdastExtensions: [gfmFromMarkdown()],
  });
  remarkTag()(tree, { value: source });
  return tree.children.map((node) => textFromNodes([node])).join("\n");
}

/** Count visible prose: Han characters, words in other scripts, and numeric runs. */
export function countMemoWords(content: string): number {
  const text = markdownText(content);
  return Array.from(text.matchAll(HAN_CHARACTERS)).length + Array.from(text.replace(HAN_CHARACTERS, " ").matchAll(WORDS)).length;
}
