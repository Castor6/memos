import type { Parent, Root, Text } from "mdast";
import { visit } from "unist-util-visit";

export function remarkHighlight() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent: Parent | undefined) => {
      if (index === undefined || !parent || !node.value.includes("==")) return;
      const parts = node.value.split(/(==[^=\n]+==)/g);
      if (parts.length === 1) return;
      const children = parts
        .filter(Boolean)
        .map((value) =>
          value.startsWith("==") && value.endsWith("==")
            ? { type: "text" as const, value: value.slice(2, -2), data: { hName: "mark" } }
            : { type: "text" as const, value },
        );
      parent.children.splice(index, 1, ...children);
      return index + children.length;
    });
  };
}
