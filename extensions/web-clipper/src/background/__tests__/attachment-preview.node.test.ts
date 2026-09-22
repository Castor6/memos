import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentPreview } from "../attachment-preview";

const resolve = vi.hoisted(() => vi.fn());
vi.mock("../connection-source", () => ({ resolveActiveConnection: resolve }));
const connection = {
  source: "direct",
  connectionId: "one",
  credentials: { instanceUrl: "https://memos.example.com", accessToken: "secret" },
};
const request = {
  expectedSource: "direct" as const,
  expectedConnectionId: "one",
  expectedInstanceUrl: "https://memos.example.com",
  path: "/file/attachments/image1/photo.png",
};

describe("attachment preview", () => {
  beforeEach(() => {
    resolve.mockReset();
    resolve.mockResolvedValue(connection);
  });
  afterEach(() => vi.unstubAllGlobals());
  it("uses a bearer header for the exact instance attachment and never follows redirects", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetcher);
    expect(await attachmentPreview(request)).toEqual({ ok: true, dataUrl: "data:image/png;base64,AQID" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://memos.example.com/file/attachments/image1/photo.png",
      expect.objectContaining({ headers: { Authorization: "Bearer secret" }, credentials: "omit", redirect: "error" }),
    );
  });
  it.each([
    "https://evil.example/a.png",
    "//evil.example/a.png",
    "/file/attachments/image1/%2e%2e",
    "/file/attachments/image1/a%2fb",
    "/api/v1/users",
  ])("rejects proxy and traversal input %s", async (path) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await attachmentPreview({ ...request, path })).toEqual({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses another account and discards results when the token changes in flight", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetcher);
    expect(await attachmentPreview({ ...request, expectedConnectionId: "other" })).toEqual({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
    resolve
      .mockResolvedValueOnce(connection)
      .mockResolvedValueOnce({ ...connection, credentials: { ...connection.credentials, accessToken: "changed" } });
    expect(await attachmentPreview(request)).toEqual({ ok: false });
  });
  it.each<Record<string, string>>([
    { "content-type": "image/svg+xml" },
    { "content-type": "image/png", "content-length": String(10 * 1024 * 1024 + 1) },
  ])("rejects unsafe or oversized content", async (headers) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unsafe", { headers })),
    );
    expect(await attachmentPreview(request)).toEqual({ ok: false });
  });
});
