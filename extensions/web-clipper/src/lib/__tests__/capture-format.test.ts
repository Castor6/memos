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

  it("omits absent context for a standalone post while preserving its text, images and source", () => {
    const image = "https://pbs.twimg.com/media/own";
    const standalone: CaptureData = {
      ...capture,
      context: "",
      posts: [{ ...capture.posts[1]!, images: [image] }],
    };
    const content = composeCaptureMemo(standalone, formatCapturedPosts(standalone));
    expect(content).toContain(`My reply\n\n![](<${image}>)`);
    expect(content).toContain(`[我的原帖](${capture.sourceUrl})`);
    expect(content).not.toContain("## Context & thinking");
    expect(content).not.toContain("## What they put down");
    expect(content).not.toContain("上文未加载");
  });

  it("omits blank source content even for a reply while retaining personal context", () => {
    const content = composeCaptureMemo(capture, " \n ");
    expect(content).toContain("## Context & thinking\n\nWhy I replied");
    expect(content).not.toContain("What they put down");
    expect(content).not.toContain("上文未加载");
  });

  it.each([true, false])("preserves empty-source pending request bodies with legacy labels %s", (legacyLabels) => {
    const content = composeCaptureMemo(capture, "", legacyLabels, false);
    expect(content).toContain(`[我的原回复](${capture.sourceUrl})`);
    expect(content).toContain(`## ${legacyLabels ? "回应内容与上文" : "What they put down"}\n\n上文未加载；请通过原回复链接查看。`);
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

  it("keeps Star images with each post, including repeated images in different posts", () => {
    const shared = "https://pbs.twimg.com/media/shared?format=jpg&name=large";
    const last = "https://pbs.twimg.com/media/last?format=png&name=large";
    const withImages: CaptureData = {
      ...capture,
      kind: "STAR",
      posts: capture.posts.map((post, index) => ({ ...post, images: index === 0 ? [shared] : [shared, last] })),
    };
    const before = structuredClone(withImages);
    const content = formatCapturedPosts(withImages);
    expect(content).toContain(`Original idea\n\n![](<${shared}>)\n\n---\n\n### [Me @me]`);
    expect(content).toContain(`My reply\n\n![](<${shared}>)\n\n![](<${last}>)`);
    expect(withImages).toEqual(before);
  });

  it("keeps Pick up reply images before provenance and source images with the original post", () => {
    const originalImage = "https://pbs.twimg.com/media/original?format=jpg";
    const replyImage = "https://pbs.twimg.com/media/reply?format=jpg";
    const withImages: CaptureData = {
      ...capture,
      comment: "  Exact reply\nwith original whitespace  ",
      posts: capture.posts.map((post, index) => ({ ...post, images: [index === 0 ? originalImage : replyImage] })),
    };
    const before = structuredClone(withImages);
    const original = formatCapturedPosts(withImages);
    expect(original).not.toContain(replyImage);
    const content = composeCaptureMemo(withImages, original);
    expect(content).toContain(`${withImages.comment}\n\n![](<${replyImage}>)\n\n[我的原帖]`);
    expect(content).toContain(`Original idea\n\n![](<${originalImage}>)`);
    expect(content.split(replyImage)).toHaveLength(2);
    expect(withImages).toEqual(before);
  });

  it("renders image-only posts and protects Markdown destinations from delimiters", () => {
    const withImages: CaptureData = {
      ...capture,
      kind: "STAR",
      posts: [{ ...capture.posts[0]!, content: "", images: ["https://pbs.twimg.com/media/a(b)<c> d\\e"] }],
    };
    expect(formatCapturedPosts(withImages)).toContain("![](<https://pbs.twimg.com/media/a(b)%3Cc%3E%20d%5Ce>)");
  });

  it("does not add reply images when reconstructing a legacy pending request", () => {
    const withImages: CaptureData = {
      ...capture,
      posts: capture.posts.map((post) => ({ ...post, images: ["https://pbs.twimg.com/media/reply"] })),
    };
    expect(composeCaptureMemo(withImages, "Previously saved source", true)).toBe(
      composeCaptureMemo(capture, "Previously saved source", true),
    );
  });
});
