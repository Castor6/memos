import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleQueryRefresh } from "@/lib/query-refresh";

afterEach(() => vi.useRealTimers());

describe("batched query refresh", () => {
  it("refreshes independent keys while another query remains in flight", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    let complete!: () => void;
    const invalidate = vi
      .spyOn(client, "invalidateQueries")
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue();
    scheduleQueryRefresh(client, ["memos", "detail", "memos/slow"]);
    await vi.advanceTimersByTimeAsync(150);
    scheduleQueryRefresh(client, ["memos", "list"], ["users", "stats"]);
    await vi.advanceTimersByTimeAsync(150);
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["memos", "list"] });
    complete();
    await vi.advanceTimersByTimeAsync(1000);
    expect(invalidate).toHaveBeenCalledTimes(3);
  });

  it("defers an overlapping parent once without polling or losing child events", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    let complete!: () => void;
    const invalidate = vi
      .spyOn(client, "invalidateQueries")
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue();
    scheduleQueryRefresh(client, ["memos", "list"]);
    await vi.advanceTimersByTimeAsync(150);
    scheduleQueryRefresh(client, ["memos"], ["memos", "list"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    complete();
    await vi.advanceTimersByTimeAsync(150);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: ["memos"] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("merges repeated live and local invalidations including parent keys", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    scheduleQueryRefresh(client, ["memos", "list"], ["users", "stats"]);
    scheduleQueryRefresh(client, ["memos", "list"]);
    scheduleQueryRefresh(client, ["memos"]);
    await vi.advanceTimersByTimeAsync(150);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["memos"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["users", "stats"] });
  });

  it("queues events received during a refresh instead of restarting it or losing them", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    let complete!: () => void;
    const invalidate = vi
      .spyOn(client, "invalidateQueries")
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue();
    scheduleQueryRefresh(client, ["memos", "list"]);
    await vi.advanceTimersByTimeAsync(150);
    scheduleQueryRefresh(client, ["memos", "list"]);
    scheduleQueryRefresh(client, ["memos", "list"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(invalidate).toHaveBeenCalledTimes(1);
    complete();
    await vi.advanceTimersByTimeAsync(150);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
