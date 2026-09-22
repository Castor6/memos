import { describe, expect, it } from "vitest";
import { composeCaptureMemo, formatCapturedPosts, utf8Bytes } from "../capture-format";
import type { CaptureData } from "../clip-records";

const capture: CaptureData = {
  kind: "PICK_UP",
  platform: "X",
  sourceUrl: "https://x.com/me/status/2",
  sourceId: "2",
  comment: "My reply",
  context: "Why I replied",
  posts: [
    {
      id: "1",
      url: "https://x.com/author/status/1",
      author: "@author",
      authorName: "Author",
      content: "Original idea",
      publishedAt: "2020-01-01T00:00:00Z",
      images: [],
    },
    {
      id: "2",
      url: "https://x.com/me/status/2",
      author: "@me",
      authorName: "Me",
      content: "My reply",
      publishedAt: "2026-09-22T00:00:00Z",
      images: [],
    },
  ],
};

describe("capture rendering", () => {
  it("keeps the original reply once, with background between it and attributed source content", () => {
    const content = composeCaptureMemo(capture, formatCapturedPosts(capture));
    expect(content.indexOf("My reply")).toBeLessThan(content.indexOf("Why I replied"));
    expect(content.indexOf("Why I replied")).toBeLessThan(content.indexOf("Original idea"));
    expect(content.match(/My reply/g)).toHaveLength(1);
    expect(content).toContain("@author");
    expect(content).toContain("## Pick up\n");
    expect(content).toContain("## Context & thinking\n");
    expect(content).toContain("## What they put down\n");
    expect(content).toContain("2026-09-22T00:00:00Z");
  });

  it("folds long sources without truncating them or hiding personal thoughts", () => {
    const body = "Original passage.\n".repeat(200);
    const content = composeCaptureMemo({ ...capture, kind: "STAR", platform: "WEB", posts: [] }, body);
    expect(content.indexOf("My reply")).toBeLessThan(content.indexOf("<details>"));
    expect(content).toContain(body.trim());
    expect(content).toContain("</details>");
  });

  it("preserves legacy headings for retrying old drafts without replacing quoted text", () => {
    const content = composeCaptureMemo(capture, "## 我的评论\n\nQuoted text", true);
    expect(content).toContain("## 我的评论\n\nMy reply");
    expect(content).toContain("## 补充背景\n\nWhy I replied");
    expect(content).toContain("## 回应内容与上文\n\n## 我的评论\n\nQuoted text");
    expect(composeCaptureMemo(capture, "## 我的评论\n\nQuoted text")).toContain("## What they put down\n\n## 我的评论\n\nQuoted text");
  });

  it("counts UTF-8 bytes including Chinese and emoji", () => {
    expect(utf8Bytes("思考👍")).toBe(10);
  });
});
