export type CaptureKind = "STAR" | "PICK_UP";

export type CapturedPost = {
  id: string;
  url: string;
  author: string;
  authorName: string;
  content: string;
  publishedAt: string;
  images: string[];
};

export type CaptureData = {
  kind: CaptureKind;
  platform: "WEB" | "X";
  sourceUrl: string;
  sourceId: string;
  comment: string;
  context: string;
  posts: CapturedPost[];
};

function httpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Parses the extension message and protobuf JSON boundaries, including omitted empty fields. */
export function parseCaptureData(value: unknown): CaptureData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.kind !== "STAR" && data.kind !== "PICK_UP") return null;
  if (data.platform !== "WEB" && data.platform !== "X") return null;
  if (!httpUrl(data.sourceUrl)) return null;
  if (data.kind === "PICK_UP" && data.platform !== "X") return null;
  for (const key of ["sourceId", "comment", "context"] as const) {
    if (data[key] !== undefined && (typeof data[key] !== "string" || data[key].length > 2 * 1024 * 1024)) return null;
  }
  if (data.posts !== undefined && (!Array.isArray(data.posts) || data.posts.length > 100)) return null;
  const posts: CapturedPost[] = [];
  for (const raw of (data.posts ?? []) as unknown[]) {
    if (!raw || typeof raw !== "object") return null;
    const post = raw as Record<string, unknown>;
    if (!httpUrl(post.url)) return null;
    for (const key of ["id", "author", "authorName", "content", "publishedAt"] as const) {
      if (post[key] !== undefined && (typeof post[key] !== "string" || post[key].length > 2 * 1024 * 1024)) return null;
    }
    if (post.publishedAt && !Number.isFinite(Date.parse(String(post.publishedAt)))) return null;
    if (post.images !== undefined && (!Array.isArray(post.images) || post.images.length > 100 || !post.images.every(httpUrl))) return null;
    posts.push({
      id: String(post.id ?? ""),
      url: post.url,
      author: String(post.author ?? ""),
      authorName: String(post.authorName ?? ""),
      content: String(post.content ?? ""),
      publishedAt: String(post.publishedAt ?? ""),
      images: (post.images ?? []) as string[],
    });
  }
  const capture: CaptureData = {
    kind: data.kind,
    platform: data.platform,
    sourceUrl: data.sourceUrl,
    sourceId: String(data.sourceId ?? ""),
    comment: String(data.comment ?? ""),
    context: String(data.context ?? ""),
    posts,
  };
  return new TextEncoder().encode(JSON.stringify(capture)).byteLength <= 2 * 1024 * 1024 ? capture : null;
}
