import type { Link, Root } from "mdast";
import { SKIP, visit } from "unist-util-visit";
import { isHttpUrl } from "@/utils/http-url";

const textOf = (node: Link) => node.children.map((child) => ("value" in child ? child.value : "")).join("");

/** Source spellings of links the author wrote on purpose: `[text](url)`, `[text][ref]` and `<url>`. */
const isExplicitLink = (node: Link, source: string) => {
  const start = node.position?.start.offset;
  if (start === undefined || !source) return false;
  const first = source[start];
  return first === "[" || first === "<";
};

/**
 * Keeps GFM literal autolinks only for explicit http(s) addresses. `www.` hosts and email
 * addresses stay plain text, while links written with Markdown syntax are left untouched.
 * Must run after remark-gfm.
 */
export const remarkHttpOnlyAutolinks = () => {
  return (tree: Root, file?: { value?: unknown }) => {
    const source = typeof file?.value === "string" ? file.value : "";
    visit(tree, "link", (node, index, parent) => {
      if (!parent || index === undefined || isExplicitLink(node, source) || isHttpUrl(textOf(node))) {
        return;
      }
      parent.children.splice(index, 1, ...node.children);
      return [SKIP, index];
    });
  };
};
