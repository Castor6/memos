import { describe, expect, it } from "vitest";
import { toggleTaskAtIndex } from "@/utils/markdown-manipulation";

describe("toggleTaskAtIndex", () => {
  it.each(["1.", "1)", "42.", "42)", "-", "*", "+"])("checks and unchecks %s tasks", (marker) => {
    expect(toggleTaskAtIndex(`${marker} [ ] Buy milk`, 0, true)).toBe(`${marker} [x] Buy milk`);
    expect(toggleTaskAtIndex(`${marker} [x] Buy milk`, 0, false)).toBe(`${marker} [ ] Buy milk`);
    expect(toggleTaskAtIndex(`${marker} [X] Buy milk`, 0, false)).toBe(`${marker} [ ] Buy milk`);
  });

  it.each(["\n", "\r\n"])("preserves formatting and targets only the selected nested task with %j line endings", (eol) => {
    const lines = ["Intro", "", "- [ ] First", "  1)  [ ] Second  ", "  2) [x] Third", "", "1. [ ] Last", ""];
    const markdown = lines.join(eol);
    lines[3] = "  1)  [x] Second  ";
    expect(toggleTaskAtIndex(markdown, 1, true)).toBe(lines.join(eol));
    expect(toggleTaskAtIndex(lines.join(eol), 1, false)).toBe(markdown);
  });

  it("ignores checkbox-looking text in fenced, indented, and inline code", () => {
    const lines = ["```md", "1. [ ] Fenced", "```", "", "    1) [ ] Indented", "", "`1. [ ] Inline`", "", "1) [ ] Real"];
    const markdown = lines.join("\n");
    lines[8] = "1) [x] Real";
    expect(toggleTaskAtIndex(markdown, 0, true)).toBe(lines.join("\n"));
    expect(toggleTaskAtIndex(markdown, 1, true)).toBe(markdown);
    expect(toggleTaskAtIndex(markdown, -1, true)).toBe(markdown);
  });
});
