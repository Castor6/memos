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
import "katex/dist/katex.min.css";

const mathOptions = currencySafeMathOptions();

const LANGUAGE = "memos-preserved-content";
const fence = (raw: string) => `\n\n\`\`\`${LANGUAGE}\n${encodeURIComponent(raw)}\n\`\`\`\n\n`;

/** Keep legacy constructs without a lossless editable representation intact. */
export function prepareMarkdown(markdown: string): string {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm(), ...(mathOptions.extensions ?? [])],
    mdastExtensions: [gfmFromMarkdown(), ...(mathOptions.mdastExtensions ?? [])],
  });
  const hasUnsupported = (node: RootContent): boolean =>
    ["html", "math", "inlineMath"].includes(node.type) || ("children" in node && node.children.some((child) => hasUnsupported(child)));
  // Footnote references and definitions can span multiple blocks.
  if (tree.children.some((node) => node.type === "footnoteDefinition")) return fence(markdown);
  let result = markdown;
  for (const node of [...tree.children].reverse()) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const raw = markdown.slice(start, end);
    if (hasUnsupported(node)) {
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
