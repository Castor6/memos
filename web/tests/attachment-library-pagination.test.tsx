import { create } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import { ATTACHMENT_LIBRARY_FILTERS, type AttachmentLibraryTab, useAttachmentLibrary } from "@/hooks/useAttachmentLibrary";
import { AttachmentSchema, MotionMediaFamily, MotionMediaRole } from "@/types/proto/api/v1/attachment_service_pb";

const list = vi.hoisted(() => vi.fn());
vi.mock("@/connect", () => ({ attachmentServiceClient: { listAttachments: list } }));
vi.mock("@/utils/i18n", () => ({ useTranslate: () => (key: string) => key }));

const setup = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  };
};

describe("attachment category pagination", () => {
  it("requests audio independently of recent images and preserves each category cursor", async () => {
    list.mockImplementation(async ({ filter, pageToken }) => {
      if (filter === "memo_id == null") return { attachments: [], nextPageToken: "" };
      if (filter === ATTACHMENT_LIBRARY_FILTERS.audio) {
        return {
          attachments: [create(AttachmentSchema, { name: "attachments/old-audio", memo: "memos/one", type: "audio/mpeg" })],
          nextPageToken: "",
        };
      }
      return {
        attachments: [create(AttachmentSchema, { name: `attachments/${pageToken || "image"}`, memo: "memos/one", type: "image/jpeg" })],
        nextPageToken: pageToken ? "" : "media-next",
      };
    });
    const { client, wrapper } = setup();
    const { result, rerender } = renderHook(({ tab }: { tab: AttachmentLibraryTab }) => useAttachmentLibrary("en", tab), {
      wrapper,
      initialProps: { tab: "media" },
    });
    await waitFor(() => expect(result.current.mediaItems).toHaveLength(1));
    rerender({ tab: "audio" });
    await waitFor(() => expect(result.current.audioItems).toHaveLength(1));
    expect(result.current.audioItems[0].attachment.name).toBe("attachments/old-audio");
    expect(list.mock.calls.some(([request]) => request.pageToken === "media-next")).toBe(false);
    rerender({ tab: "media" });
    await waitFor(() => expect(result.current.mediaItems).toHaveLength(1));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.mediaItems).toHaveLength(2));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ filter: ATTACHMENT_LIBRARY_FILTERS.media, pageToken: "media-next" }), {
      signal: expect.any(AbortSignal),
    });
    client.clear();
  });

  it("pairs Live Photo members across media pages and pages unused files separately", async () => {
    const still = create(AttachmentSchema, {
      name: "attachments/still",
      memo: "memos/one",
      filename: "live.jpg",
      type: "image/jpeg",
      motionMedia: { family: MotionMediaFamily.APPLE_LIVE_PHOTO, role: MotionMediaRole.STILL, groupId: "live" },
    });
    const video = create(AttachmentSchema, {
      name: "attachments/video",
      memo: "memos/one",
      filename: "live.mov",
      type: "video/quicktime",
      motionMedia: { family: MotionMediaFamily.APPLE_LIVE_PHOTO, role: MotionMediaRole.VIDEO, groupId: "live" },
    });
    list.mockImplementation(async ({ filter, pageToken }) => {
      if (filter === "memo_id == null") {
        return {
          attachments: [create(AttachmentSchema, { name: `attachments/unused-${pageToken || "first"}`, type: "text/plain" })],
          nextPageToken: pageToken ? "" : "unused-next",
        };
      }
      return { attachments: [pageToken ? video : still], nextPageToken: pageToken ? "" : "media-next" };
    });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useAttachmentLibrary("en", "media"), { wrapper });
    await waitFor(() => expect(result.current.mediaItems).toHaveLength(1));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.mediaItems[0]?.kind).toBe("motion"));
    expect(result.current.mediaItems).toHaveLength(1);
    expect(result.current.mediaItems[0].attachmentNames).toEqual([still.name, video.name]);
    await act(async () => {
      await result.current.unusedQuery.fetchNextPage();
    });
    await waitFor(() => expect(result.current.unusedItems).toHaveLength(2));
    expect(result.current.mediaItems).toHaveLength(1);
    client.clear();
  });
});
