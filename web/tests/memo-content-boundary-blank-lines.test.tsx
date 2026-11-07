import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MemoMarkdownRendererCore } from "@/components/MemoContent/MemoMarkdownRenderer";

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ userGeneralSetting: undefined }) }));

function renderContent(content: string, maxCharacters = 0) {
  const result = render(
    <MemoryRouter>
      <div data-testid="content">
        <MemoMarkdownRendererCore content={content} maxCharacters={maxCharacters} resolvedMentionUsernames={new Set()} />
      </div>
    </MemoryRouter>,
  );
  return result.getByTestId("content");
}

describe("reading display boundary blank lines", () => {
  it("hides the non-breaking-space paragraphs emitted by consecutive empty editor paragraphs", () => {
    const element = renderContent("\n\n&nbsp;\n\n&nbsp;\n\nBody\n\n&nbsp;\n\n&nbsp;\n\n");
    expect(element.children).toHaveLength(1);
    expect(element.firstElementChild).toHaveTextContent("Body");
  });

  it("hides empty paragraphs and standalone breaks at the document boundaries", () => {
    const element = renderContent("<p></p>\n<br>\n<p><br></p>\n<p>Body</p>\n<p> </p>\n<br>");
    expect(element.children).toHaveLength(1);
    expect(element.firstElementChild).toHaveTextContent("Body");
  });

  it("preserves blank lines between content paragraphs and hard breaks inside a paragraph", () => {
    const element = renderContent("First\n\n&nbsp;\n\nSecond\nline\n\n&nbsp;");
    expect(element.querySelectorAll(":scope > p")).toHaveLength(3);
    expect(element.children[1].textContent).toBe("\u00a0");
    expect(element.querySelectorAll("br")).toHaveLength(1);
  });

  it("preserves blank paragraphs inside a fold even when the fold is at the document boundary", () => {
    const element = renderContent("&nbsp;\n\n<details><summary>Fold</summary><p>&nbsp;</p><p>Body</p><p>&nbsp;</p></details>\n\n&nbsp;");
    expect(element.children).toHaveLength(1);
    expect(element.firstElementChild?.tagName).toBe("DETAILS");
    const paragraphs = element.querySelectorAll("details p");
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0].textContent).toBe("\u00a0");
    expect(paragraphs[2].textContent).toBe("\u00a0");
  });

  it("preserves list and code whitespace", () => {
    const element = renderContent("<ul><li><p>&nbsp;</p><p>Item</p><p>&nbsp;</p></li></ul>\n\n```\n\n  indented\n\n```");
    expect(element.querySelectorAll("li p")).toHaveLength(3);
    expect(element.querySelector("pre code")?.textContent).toBe("\n  indented\n");
  });

  it("keeps semantic empty elements such as links, images and anchors", () => {
    const element = renderContent('<p id="anchor">&nbsp;</p>\n\n[ ](https://example.com)\n\n![](https://example.com/image.png)');
    expect(element.querySelector("#anchor")).not.toBeNull();
    expect(element.querySelector("a")).not.toBeNull();
    expect(element.querySelector("img")).not.toBeNull();
  });

  it("renders a document made only of blank lines without empty paragraphs", () => {
    expect(renderContent("\n\n&nbsp;\n\n&nbsp;\n").children).toHaveLength(0);
  });

  it("does not spend a collapsed preview's character limit on hidden boundary paragraphs", () => {
    expect(renderContent(`${"&nbsp;\n\n".repeat(5)}Visible body\n\n&nbsp;`, 5)).toHaveTextContent("Visib");
  });
});
