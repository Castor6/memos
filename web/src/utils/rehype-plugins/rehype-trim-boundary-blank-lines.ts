import type { Root, RootContent } from "hast";

function isBlankLine(node: RootContent): boolean {
  if (node.type === "text") return node.value.trim() === "";
  if (node.type !== "element" || Object.keys(node.properties).length > 0) return false;
  if (node.tagName === "br") return true;
  return node.tagName === "p" && node.children.every((child) => (child.type === "text" ? child.value.trim() === "" : isBlankLine(child)));
}

/** Hide only document-boundary blank lines without changing stored Markdown or nested content. */
export const rehypeTrimBoundaryBlankLines = () => (tree: Root) => {
  let start = 0;
  let end = tree.children.length;
  while (start < end && isBlankLine(tree.children[start])) start++;
  while (end > start && isBlankLine(tree.children[end - 1])) end--;
  tree.children = tree.children.slice(start, end);
};
