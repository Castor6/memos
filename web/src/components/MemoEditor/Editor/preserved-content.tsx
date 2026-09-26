import { Node } from "@tiptap/core";
import { type NodeViewProps, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import type { RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { memoUrlTransform, SANITIZE_SCHEMA } from "@/components/MemoContent/constants";
import { currencySafeMathOptions, remarkCurrencySafeMath } from "@/utils/remark-plugins/remark-currency-safe-math";
import { detailsFence, parseDetailsSource } from "./editable-details";
import "katex/dist/katex.min.css";

const mathOptions = currencySafeMathOptions();

const LANGUAGE = "memos-preserved-content";
const fence = (raw: string) => `\`\`\`${LANGUAGE}\n${encodeURIComponent(raw)}\n\`\`\``;

/** Keep legacy constructs without a lossless editable representation intact. */
export function prepareMarkdown(markdown: string): string {
  const initialTree = fromMarkdown(markdown, {
    extensions: [gfm(), ...(mathOptions.extensions ?? [])],
    mdastExtensions: [gfmFromMarkdown(), ...(mathOptions.mdastExtensions ?? [])],
  });
  // Footnote references and definitions can span multiple blocks.
  if (initialTree.children.some((node) => node.type === "footnoteDefinition")) return fence(markdown);
  const codeRanges: Array<[number, number]> = [];
  const collectCode = (node: {
    type: string;
    position?: { start: { offset?: number }; end: { offset?: number } };
    children?: unknown[];
  }) => {
    if (
      (node.type === "code" || node.type === "inlineCode") &&
      node.position?.start.offset !== undefined &&
      node.position.end.offset !== undefined
    )
      codeRanges.push([node.position.start.offset, node.position.end.offset]);
    node.children?.forEach((child) => collectCode(child as typeof node));
  };
  collectCode(initialTree);
  const ranges: Array<{ start: number; end: number; raw: string }> = [];
  const tags = /<\/?details\b[^>]*>/gi;
  let depth = 0;
  let start = -1;
  for (const match of markdown.matchAll(tags)) {
    const offset = match.index;
    if (codeRanges.some(([a, b]) => offset >= a && offset < b)) continue;
    const container = initialTree.children.find(
      (node) =>
        ["blockquote", "list"].includes(node.type) &&
        node.position?.start.offset !== undefined &&
        node.position.end.offset !== undefined &&
        offset >= node.position.start.offset &&
        offset < node.position.end.offset,
    );
    if (container?.position?.start.offset !== undefined && container.position.end.offset !== undefined) {
      const start = container.position.start.offset;
      const end = container.position.end.offset;
      if (!ranges.some((range) => range.start === start)) ranges.push({ start, end, raw: markdown.slice(start, end) });
      continue;
    }
    if (!match[0].startsWith("</")) {
      if (depth === 0) start = offset;
      depth++;
    } else if (depth > 0 && --depth === 0) {
      ranges.push({ start, end: offset + match[0].length, raw: markdown.slice(start, offset + match[0].length) });
    }
  }
  for (const range of ranges.sort((a, b) => b.start - a.start)) {
    const before = markdown.slice(0, range.start);
    const after = markdown.slice(range.end);
    const prefix = before && !before.endsWith("\n") ? "\n\n" : "";
    const suffix = after && !after.startsWith("\n") ? "\n\n" : "";
    markdown = before + prefix + (parseDetailsSource(range.raw) ? detailsFence(range.raw) : fence(range.raw)) + suffix + after;
  }
  const tree = fromMarkdown(markdown, {
    extensions: [gfm(), ...(mathOptions.extensions ?? [])],
    mdastExtensions: [gfmFromMarkdown(), ...(mathOptions.mdastExtensions ?? [])],
  });
  const hasUnsupported = (node: RootContent): boolean =>
    ["html", "math", "inlineMath"].includes(node.type) || ("children" in node && node.children.some((child) => hasUnsupported(child)));

  let result = markdown;
  for (const node of [...tree.children].reverse()) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const raw = markdown.slice(start, end);
    const withoutUnderline = raw.replace(/<u>[\s\S]*?<\/u>/g, (value) => value.slice(3, -4));
    const underlineOnly =
      withoutUnderline !== raw &&
      !fromMarkdown(withoutUnderline, {
        extensions: [gfm(), ...(mathOptions.extensions ?? [])],
        mdastExtensions: [gfmFromMarkdown(), ...(mathOptions.mdastExtensions ?? [])],
      }).children.some(hasUnsupported);
    if (hasUnsupported(node) && !underlineOnly) {
      result = result.slice(0, start) + fence(raw) + result.slice(end);
    }
  }
  return result;
}

function PreservedView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper contentEditable={false} className="rounded border border-dashed p-2 my-2" title="原有内容已保留，可在前后继续编辑">
      <ReactMarkdown
        urlTransform={memoUrlTransform}
        remarkPlugins={[remarkCurrencySafeMath, remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA], rehypeKatex]}
      >
        {String(node.attrs.raw)}
      </ReactMarkdown>
    </NodeViewWrapper>
  );
}

export const PreservedContent = Node.create({
  name: "preservedContent",
  group: "block",
  atom: true,
  priority: 50,
  addAttributes: () => ({ raw: { default: "" } }),
  parseHTML: () => [],
  renderHTML: ({ node }) => ["div", { "data-preserved-content": "true" }, node.attrs.raw],
  markdownTokenName: "memosPreserved",
  markdownTokenizer: {
    name: "memosPreserved",
    level: "block",
    start: (source: string) => source.indexOf("```" + LANGUAGE),
    tokenize: (source: string) => {
      const match = /^```memos-preserved-content\n([^\n]*)\n```/.exec(source);
      if (match) return { type: "memosPreserved", raw: match[0], text: match[1] };
    },
  },
  parseMarkdown: (token, helpers) => {
    try {
      return helpers.createNode("preservedContent", { raw: decodeURIComponent(token.text || "") });
    } catch {
      return [];
    }
  },
  renderMarkdown: (node) => node.attrs?.raw || "",
  addNodeView: () => ReactNodeViewRenderer(PreservedView),
});
