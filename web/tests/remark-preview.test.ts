import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vitest";
import { remarkPreview, visibleCharacterCount } from "@/utils/remark-plugins/remark-preview";

describe("preview boundary blank paragraphs", () => {
  it("does not spend the preview budget on leading editor blank paragraphs", () => {
    const source = `${"&nbsp;\n\n".repeat(5)}Visible body`;
    const tree = fromMarkdown(source);
    remarkPreview({ limit: 5 })(tree);

    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]).toMatchObject({ type: "paragraph", children: [{ type: "text", value: "Visib" }] });
    expect(visibleCharacterCount(source)).toBe(12);
  });

  it("does not count trailing blank paragraphs as hidden content requiring expansion", () => {
    const source = `Body\n\n${"&nbsp;\n\n".repeat(5)}`;
    const tree = fromMarkdown(source);
    remarkPreview({ limit: 4 })(tree);

    expect(visibleCharacterCount(source)).toBe(4);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]).toMatchObject({ children: [{ value: "Body" }] });
  });

  it("keeps interior blank paragraphs and their character count", () => {
    const source = "First\n\n&nbsp;\n\nSecond";
    const tree = fromMarkdown(source);
    const original = structuredClone(tree);
    remarkPreview({ limit: 100 })(tree);

    expect(tree).toEqual(original);
    expect(visibleCharacterCount(source)).toBe(12);
  });

  it("does not trim root paragraphs enclosed by raw HTML folding boundaries", () => {
    const source = "<details>\n<summary>Fold</summary>\n\n&nbsp;\n\nBody\n\n&nbsp;\n\n</details>";
    const tree = fromMarkdown(source);
    const original = structuredClone(tree);
    remarkPreview({ limit: 100 })(tree);

    expect(tree).toEqual(original);
    expect(visibleCharacterCount(source)).toBe(6);
  });

  it.each([
    "> &nbsp;\n>\n> Body\n>\n> &nbsp;",
    "- &nbsp;\n- Body\n- &nbsp;",
    "```\n\n Body\n\n```",
  ])("keeps nested and code whitespace in %s", (source) => {
    const tree = fromMarkdown(source);
    const original = structuredClone(tree);
    remarkPreview({ limit: 100 })(tree);
    expect(tree).toEqual(original);
    expect(visibleCharacterCount(source)).toBeGreaterThan(4);
  });

  it("preserves semantic blank content at the root boundary", () => {
    const source = "[&nbsp;](https://example.com)\n\n![ ](https://example.com/image.png)\n\nBody";
    const tree = fromMarkdown(source);
    const original = structuredClone(tree);
    remarkPreview({ limit: 100 })(tree);

    expect(tree).toEqual(original);
    expect(visibleCharacterCount(source)).toBe(5);
  });

  it("produces an empty preview and count for an entirely blank document", () => {
    const source = "&nbsp;\n\n&nbsp;\n\n";
    const tree = fromMarkdown(source);
    remarkPreview({ limit: 1 })(tree);

    expect(tree.children).toEqual([]);
    expect(visibleCharacterCount(source)).toBe(0);
  });
});
