import type { CaptureData } from "./clip-records";

/** Preserve provenance without mixing it into personal observations. */
export function formatCapturedPosts(capture: CaptureData): string {
  return capture.posts
    .filter((post) => capture.kind !== "PICK_UP" || post.id !== capture.sourceId)
    .map((post) => {
      const author = [post.authorName, post.author].filter(Boolean).join(" ");
      const label = author.replace(/[[\]\n]/g, " ") || "原帖";
      return `### [${label}](${post.url})\n\n${post.publishedAt}\n\n${post.content}`.trim();
    })
    .join("\n\n---\n\n");
}

export function composeCaptureMemo(capture: CaptureData, original: string, legacyLabels = false): string {
  const sections: string[] = [];
  const body = original.trim();
  const displayedOriginal = body.length > 1600 ? `<details>\n<summary>展开原内容</summary>\n\n${body}\n\n</details>` : body;
  if (capture.kind === "PICK_UP") {
    const ownPost = capture.posts.find((post) => post.id === capture.sourceId);
    const provenance = ownPost ? ` · ${ownPost.author} · ${ownPost.publishedAt}` : "";
    sections.push(`## ${legacyLabels ? "我的评论" : "Pick up"}\n\n${capture.comment}\n\n[我的原回复](${capture.sourceUrl})${provenance}`);
    if (capture.context.trim()) sections.push(`## ${legacyLabels ? "补充背景" : "Context & thinking"}\n\n${capture.context.trim()}`);
    sections.push(
      `## ${legacyLabels ? "回应内容与上文" : "What they put down"}\n\n${displayedOriginal || "上文未加载；请通过原回复链接查看。"}`,
    );
  } else {
    if (capture.comment.trim()) sections.push(`## 我的思考\n\n${capture.comment.trim()}`);
    sections.push(`## 原内容\n\n${displayedOriginal}`);
  }
  return sections.join("\n\n");
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
