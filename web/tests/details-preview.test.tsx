import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ClampedSection from "@/components/ClampedSection";
import { MemoMarkdownRenderer } from "@/components/MemoContent/MemoMarkdownRenderer";

vi.mock("@/utils/i18n", () => ({ findNearestMatchedLanguage: () => "en", useTranslate: () => (key: string) => key === "memo.show-more" ? "展开" : "收起" }));

const content = "Intro\n\n<details><summary>Title</summary>\n\n**Body**\n\n</details>\n\nTail";

describe("folded Markdown preview", () => {
  it("reveals the full card when a section opens and keeps it open across the preview rerender", async () => {
    const { container } = render(
      <ClampedSection enabled characterLimit={10} textLength={100}>
        {(collapsed) => <MemoMarkdownRenderer content={content} maxCharacters={collapsed ? 10 : 0} resolvedMentionUsernames={new Set()} />}
      </ClampedSection>,
    );
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(container.querySelector(".overflow-hidden")).not.toBeNull();
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(container.querySelector(".overflow-hidden")).toBeNull());
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(details.querySelector("strong")).toHaveTextContent("Body");
    expect(container).toHaveTextContent("Tail");
    fireEvent.click(details.querySelector("button")!);
    expect(details.open).toBe(false);
    expect(container.firstElementChild?.lastElementChild).toHaveTextContent("收起");
  });

  it("collapses only the selected nested section and retains rich summary formatting", () => {
    const { container } = render(<MemoMarkdownRenderer
      content="<details><summary><strong>Outer</strong></summary><details><summary>Inner</summary>Nested body</details></details>"
      resolvedMentionUsernames={new Set()}
    />);
    const [outer, inner] = container.querySelectorAll("details");
    outer.open = inner.open = true;
    expect(outer.querySelector("summary strong")).toHaveTextContent("Outer");
    fireEvent.click(inner.querySelector("button")!);
    expect(inner.open).toBe(false);
    expect(outer.open).toBe(true);
  });
});
