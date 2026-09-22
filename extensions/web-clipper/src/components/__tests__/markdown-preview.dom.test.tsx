import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { composeCaptureMemo } from "@/lib/capture-format";
import { MarkdownPreview } from "../markdown-preview";

describe("MarkdownPreview", () => {
  it("preserves soft line breaks in multiline Pick up comments", () => {
    const { container } = render(<MarkdownPreview content={"## Pick up\n\n第一行评论\n第二行评论\n第三行评论"} />);
    expect(container.querySelector("p")?.innerHTML).toBe("第一行评论<br>\n第二行评论<br>\n第三行评论");
  });

  it("renders Markdown structure, GFM, links and images", () => {
    const { container } = render(
      <MarkdownPreview
        content={
          "## Heading\n\n**Bold** and ~~removed~~\n\n- first\n- second\n\n1. ordered\n\n> quoted\n\n`inline`\n\n```js\nconst x = 1;\n```\n\n| A | B |\n| - | - |\n| one | two |\n\n[Source](https://example.com)\n\n![Photo](https://example.com/photo.jpg)"
        }
      />,
    );
    expect(screen.getByRole("heading", { name: "Heading", level: 2 })).toBeInTheDocument();
    expect(container.querySelector("strong")).toHaveTextContent("Bold");
    expect(container.querySelector("del")).toHaveTextContent("removed");
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(container.querySelector("blockquote")).toHaveTextContent("quoted");
    expect(container.querySelector("pre code")).toHaveTextContent("const x = 1;");
    expect(screen.getByRole("table")).toHaveTextContent("onetwo");
    expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute("href", "https://example.com");
    expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("img", { name: "Photo" })).toHaveAttribute("src", "https://example.com/photo.jpg");
  });

  it("renders the actual long-source template as closed details with Markdown inside", () => {
    const content = composeCaptureMemo(
      { kind: "STAR", platform: "WEB", sourceId: "", sourceUrl: "https://example.com", comment: "Thought", context: "", posts: [] },
      `## Original heading\n\n${"Long passage. ".repeat(150)}`,
    );
    const { container } = render(<MarkdownPreview content={content} />);
    const details = container.querySelector("details");
    expect(details).toBeInTheDocument();
    expect(details).not.toHaveAttribute("open");
    expect(details?.querySelector("summary")).toHaveTextContent("展开原内容");
    expect(details?.querySelector("h2")).toHaveTextContent("Original heading");
    expect(details).toHaveTextContent("Long passage.");
    expect(container.querySelector("details p")).not.toHaveTextContent("Thought");
  });

  it("removes executable HTML, event attributes and unsafe URLs", () => {
    const { container } = render(
      <MarkdownPreview
        content={
          '<script>alert(1)</script>\n\n<iframe src="https://evil.example"></iframe>\n\n<img src="https://example.com/safe.png" onerror="alert(1)">\n\n<a href="javascript:alert(1)" onclick="alert(1)">unsafe</a>\n\n[markdown attack](javascript:alert%281%29)\n\n<img src="data:image/svg+xml,evil">\n\n<div style="position:fixed" id="location">text</div>'
        }
      />,
    );
    expect(container.querySelector("script, iframe, [onerror], [onclick], [style]")).toBeNull();
    for (const link of container.querySelectorAll("a")) {
      expect(link.getAttribute("href") || "").not.toMatch(/javascript:/i);
    }
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("#location")).toBeNull();
    expect(container.querySelector("img")).toHaveAttribute("src", "https://example.com/safe.png");
  });
});
