import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserMock } from "@/test/browser-mock";
import { jsonResponse } from "@/test/fixtures";
import {
  type ClipConnection,
  findLatestClipStatus,
  findServerClipStatus,
  listClipRecords,
  normalizeClipSourceUrl,
  recordSuccessfulClip,
} from "../clip-records";

const connection: ClipConnection = {
  source: "direct",
  connectionId: "direct_123",
  credentials: {
    instanceUrl: "https://memos.example.com/",
    accessToken: "secret",
  },
  user: {
    name: "users/steven",
    displayName: "Steven",
  },
};

describe("clip records", () => {
  beforeEach(async () => {
    await browserMock.storage.local.clear();
  });

  it("normalizes only known tracking noise while preserving page semantics", () => {
    expect(normalizeClipSourceUrl("https://example.com/post?id=7&utm_source=email#comments")).toBe("https://example.com/post?id=7");
    expect(normalizeClipSourceUrl("https://example.com/app#/notes/42")).toBe("https://example.com/app#/notes/42");
    expect(normalizeClipSourceUrl("https://example.com/search?q=web+clipper")).toBe("https://example.com/search?q=web+clipper");
  });

  it("queries separate capture kinds with meaningful URL parameters and each device's current token", async () => {
    const fetchMock = vi.fn((value: unknown, _init?: RequestInit) =>
      Promise.resolve(
        String(value).includes("/instance/profile")
          ? jsonResponse({ version: "dev", webClipperSupported: true })
          : jsonResponse({ memos: [] }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await findServerClipStatus(connection, "https://example.org/post?id=7&utm_source=mail#comments", "STAR");
    await findServerClipStatus(
      { ...connection, connectionId: "another-device", credentials: { ...connection.credentials, accessToken: "different-token" } },
      "https://example.org/post?id=7",
      "PICK_UP",
    );
    const queries = fetchMock.mock.calls.filter(([value]) => String(value).includes("/memos?"));
    expect(queries).toHaveLength(4);
    expect(new URL(String(queries[0]?.[0])).searchParams.get("filter")).toBe(
      'has_capture == true && capture_source_url == "https://example.org/post?id=7" && capture_kind == "STAR"',
    );
    expect(new URL(String(queries[2]?.[0])).searchParams.get("filter")).toBe(
      'has_capture == true && capture_source_url == "https://example.org/post?id=7" && capture_kind == "PICK_UP"',
    );
    expect(queries[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer secret" });
    expect(queries[2]?.[1]?.headers).toMatchObject({ Authorization: "Bearer different-token" });
    vi.unstubAllGlobals();
  });

  it("keeps every save and returns the newest matching record", async () => {
    const capture = {
      sourceUrl: "https://example.com/post?utm_campaign=newsletter",
      sourceTitle: "A useful post",
      selectionMarkdown: "A selected paragraph",
      imageCount: 1,
    };
    await recordSuccessfulClip({
      connection,
      capture,
      recordId: "clip_first",
      memoContent: "First memo",
      visibility: "PRIVATE",
      memoUrl: "https://memos.example.com/m/first",
      savedAt: 100,
    });
    await recordSuccessfulClip({
      connection,
      capture: { ...capture, sourceUrl: "https://example.com/post#section" },
      recordId: "clip_second",
      memoContent: "Second memo",
      visibility: "PROTECTED",
      memoUrl: "https://memos.example.com/m/second",
      savedAt: 200,
    });

    const records = await listClipRecords();
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.id)).toEqual(["clip_second", "clip_first"]);
    expect(records[0]).toMatchObject({
      selection: { markdown: "A selected paragraph", imageCount: 1 },
      memoContent: "Second memo",
      memoName: "memos/clip_second",
      visibility: "PROTECTED",
    });
    expect(await findLatestClipStatus(connection, "https://example.com/post?utm_medium=social")).toEqual({
      memoUrl: "https://memos.example.com/m/second",
      savedAt: 200,
    });
    expect(await findLatestClipStatus({ ...connection, connectionId: "reconnected" }, "https://example.com/post")).not.toBeNull();
  });
});
