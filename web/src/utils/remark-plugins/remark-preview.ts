import type { Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

interface PreviewNode {
  type: string;
  value?: string;
  children?: PreviewNode[];
}
const segments = (text: string) =>
  Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment);

export function visibleCharacterCount(markdown: string): number {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const count = (node: PreviewNode): number => {
    if (["text", "inlineCode", "code", "math", "inlineMath"].includes(node.type)) return segments(node.value || "").length;
    return node.children?.reduce((sum, child) => sum + count(child), 0) || 0;
  };
  return count(tree);
}

/** Trim rendered text nodes, preserving markup and grapheme boundaries. */
export function remarkPreview({ limit = 0 }: { limit?: number } = {}) {
  return (tree: Root) => {
    if (limit <= 0) return;
    let remaining = limit;
    const trim = (node: PreviewNode) => {
      if (["text", "inlineCode", "code", "math", "inlineMath"].includes(node.type)) {
        const text = segments(node.value || "");
        node.value = text.slice(0, remaining).join("");
        remaining = Math.max(0, remaining - text.length);
      }
      if (node.children) {
        const kept: PreviewNode[] = [];
        for (const child of node.children) {
          if (!remaining) break;
          trim(child);
          kept.push(child);
        }
        node.children = kept;
      }
    };
    trim(tree);
  };
}
