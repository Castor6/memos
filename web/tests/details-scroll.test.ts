import { afterEach, describe, expect, it, vi } from "vitest";
import { revealFoldHeading } from "@/components/Details/scroll";

const bounds = (top: number, bottom: number) => ({ top, bottom } as DOMRect);
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("folding scroll restoration", () => {
  it("does not move the viewport when the collapsed heading remains visible", () => {
    const heading = document.createElement("button");
    document.body.append(heading);
    heading.scrollIntoView = vi.fn();
    vi.spyOn(heading, "getBoundingClientRect").mockReturnValue(bounds(30, 50));
    revealFoldHeading(heading);
    expect(heading.scrollIntoView).not.toHaveBeenCalled();
  });

  it("reveals a long section's heading above the page viewport", () => {
    const heading = document.createElement("summary");
    document.body.append(heading);
    heading.scrollIntoView = vi.fn();
    vi.spyOn(heading, "getBoundingClientRect").mockReturnValue(bounds(-500, -480));
    revealFoldHeading(heading);
    expect(heading.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("also reveals headings clipped inside the independently scrolling editor", () => {
    const editor = document.createElement("div");
    editor.style.overflowY = "auto";
    const heading = document.createElement("button");
    editor.append(heading);
    document.body.append(editor);
    heading.scrollIntoView = vi.fn();
    vi.spyOn(editor, "getBoundingClientRect").mockReturnValue(bounds(100, 400));
    vi.spyOn(heading, "getBoundingClientRect").mockReturnValue(bounds(50, 70));
    revealFoldHeading(heading);
    expect(heading.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });
});
