import { beforeEach, describe, expect, it, vi } from "vitest";
import { renamedTag, renameTagInMemos } from "@/lib/rename-tag";
import { State } from "@/types/proto/api/v1/common_pb";

const client = vi.hoisted(() => ({ listMemos: vi.fn(), getMemo: vi.fn(), updateMemo: vi.fn() }));
vi.mock("@/connect", () => ({ memoServiceClient: client }));
beforeEach(() => {
  vi.resetAllMocks();
  client.listMemos.mockResolvedValue({ memos: [], nextPageToken: "" });
  client.updateMemo.mockResolvedValue({});
});
describe("rename tag", () => {
  it("matches complete tags and descendants, never similar prefixes", () => {
    expect(renamedTag("work/a", "work", "项目")).toBe("项目/a");
    expect(renamedTag("working", "work", "项目")).toBe("working");
  });
  it("collects pages before updating and preserves fresh unrelated tags without changing content", async () => {
    client.listMemos.mockResolvedValueOnce({ memos: [{ name: "memos/a", creator: "users/1", tags: ["work"] }], nextPageToken: "second" });
    client.listMemos.mockResolvedValueOnce({
      memos: [
        { name: "memos/b", creator: "users/1", tags: ["work/child"] },
        { name: "memos/other", creator: "users/2", tags: ["work"] },
      ],
      nextPageToken: "",
    });
    client.getMemo
      .mockResolvedValueOnce({ creator: "users/1", tags: ["work", "fresh", "项目"] })
      .mockResolvedValueOnce({ creator: "users/1", tags: ["work/child"] });
    await renameTagInMemos("users/1", "work", "项目");
    expect(client.listMemos).toHaveBeenCalledTimes(5);
    expect(client.listMemos.mock.calls[1][0].pageToken).toBe("second");
    expect(client.listMemos).toHaveBeenCalledWith(expect.objectContaining({ isTodo: true, state: State.ARCHIVED }));
    expect(client.listMemos.mock.invocationCallOrder.at(-1)).toBeLessThan(client.updateMemo.mock.invocationCallOrder[0]);
    expect(client.updateMemo).toHaveBeenNthCalledWith(1, {
      memo: { name: "memos/a", tags: ["项目", "fresh"] },
      updateMask: { paths: ["tags"] },
    });
    expect(client.updateMemo).toHaveBeenNthCalledWith(2, {
      memo: { name: "memos/b", tags: ["项目/child"] },
      updateMask: { paths: ["tags"] },
    });
  });
  it("does not write when a later page fails", async () => {
    client.listMemos
      .mockResolvedValueOnce({ memos: [{ name: "memos/a", creator: "users/1", tags: ["work"] }], nextPageToken: "second" })
      .mockRejectedValueOnce(new Error("offline"));
    await expect(renameTagInMemos("users/1", "work", "项目")).rejects.toThrow("offline");
    expect(client.updateMemo).not.toHaveBeenCalled();
  });
  it("rejects overlong descendants before any writes", async () => {
    client.listMemos.mockResolvedValueOnce({
      memos: [{ name: "memos/a", creator: "users/1", tags: [`work/${"a".repeat(250)}`] }],
      nextPageToken: "",
    });
    await expect(renameTagInMemos("users/1", "work", "项目项目")).rejects.toThrow("256");
    expect(client.updateMemo).not.toHaveBeenCalled();
  });
});
