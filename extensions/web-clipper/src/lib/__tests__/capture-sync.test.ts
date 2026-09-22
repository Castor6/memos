import { describe, expect, it, vi } from "vitest";
import { parseBackgroundRequest } from "@/lib/background-protocol";
import { parseCaptureData } from "@/lib/capture-data";
import { createMemo, getMemo, listCapturedMemos } from "@/lib/memos-client";
import { jsonResponse, testCreds } from "@/test/fixtures";

const capture = {
  kind: "STAR" as const,
  platform: "WEB" as const,
  sourceUrl: "https://example.org/a",
  sourceId: "",
  comment: "思考",
  context: "",
  posts: [],
};
const memo = {
  name: "memos/id",
  creator: "users/1",
  content: "Current server body",
  visibility: "PRIVATE",
  createTime: "2026-09-22T00:00:00Z",
  capture,
};

describe("capture sync API", () => {
  it("follows every page and safely quotes a source URL in the owner-scoped capture filter", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ memos: [memo], nextPageToken: "second" }))
      .mockResolvedValueOnce(jsonResponse({ memos: [{ ...memo, name: "memos/other" }] }));
    const sourceUrl = 'https://example.org/?q=" && true';
    const records = await listCapturedMemos(testCreds, { state: "ARCHIVED", sourceUrl, kind: "STAR" }, { fetchImpl });
    expect(records.map((record) => record.name)).toEqual(["memos/id", "memos/other"]);
    const firstUrl = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(firstUrl.searchParams.get("filter")).toBe(
      `has_capture == true && capture_source_url == ${JSON.stringify(sourceUrl)} && capture_kind == "STAR"`,
    );
    expect(firstUrl.searchParams.get("state")).toBe("ARCHIVED");
    expect(new URL(String(fetchImpl.mock.calls[1]?.[0])).searchParams.get("pageToken")).toBe("second");
  });

  it("rejects legacy responses that silently omit structured capture", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ memos: [{ ...memo, capture: undefined }] }));
    await expect(listCapturedMemos(testCreds, { state: "NORMAL" }, { fetchImpl })).rejects.toMatchObject({ kind: "bad-response" });
  });

  it("distinguishes a deleted resource from a failed reconciliation", async () => {
    await expect(getMemo(testCreds, "saved-id", { fetchImpl: vi.fn().mockResolvedValue(jsonResponse({}, 404)) })).resolves.toBeNull();
    await expect(getMemo(testCreds, "saved-id", { fetchImpl: vi.fn().mockResolvedValue(jsonResponse({}, 403)) })).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });

  it("preserves explicit server length errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: "content length exceeds 8192 bytes" }, 400));
    await expect(createMemo(testCreds, { content: "long", visibility: "PRIVATE", capture }, { fetchImpl })).rejects.toMatchObject({
      kind: "content-too-large",
      message: "content length exceeds 8192 bytes",
    });
  });
});

describe("capture boundary", () => {
  it("accepts protobuf JSON empty-field omissions but rejects unsafe URLs and mismatched modes", () => {
    expect(parseCaptureData({ kind: "STAR", platform: "WEB", sourceUrl: capture.sourceUrl })).toEqual({ ...capture, comment: "" });
    expect(parseCaptureData({ ...capture, sourceUrl: "javascript:alert(1)" })).toBeNull();
    expect(parseCaptureData({ ...capture, kind: "PICK_UP" })).toBeNull();
    expect(parseCaptureData({ ...capture, posts: [{ url: "https://x.com/u/status/123", images: ["data:bad"] }] })).toBeNull();
  });

  it("requires connection expectations before capability queries", () => {
    expect(parseBackgroundRequest({ type: "GET_CAPTURE_CAPABILITIES" })).toBeNull();
    expect(
      parseBackgroundRequest({
        type: "GET_CAPTURE_CAPABILITIES",
        expectedSource: "direct",
        expectedConnectionId: "connection",
        expectedInstanceUrl: testCreds.instanceUrl,
      }),
    ).not.toBeNull();
  });
});
