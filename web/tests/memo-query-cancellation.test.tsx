import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { expect, it, vi } from "vitest";
import { memoKeys, useInfiniteMemos } from "@/hooks/useMemoQueries";

const list = vi.hoisted(() => vi.fn());
vi.mock("@/connect", () => ({ memoServiceClient: { listMemos: list }, userServiceClient: {}, shortcutServiceClient: {} }));

it("aborts the RPC transport when a memo page query is cancelled", async () => {
  list.mockReturnValue(new Promise(() => {}));
  const client = new QueryClient();
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { unmount } = renderHook(() => useInfiniteMemos(), { wrapper });
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  const signal = list.mock.calls[0][1].signal as AbortSignal;
  expect(signal.aborted).toBe(false);
  await client.cancelQueries({ queryKey: memoKeys.lists() });
  expect(signal.aborted).toBe(true);
  unmount();
  client.clear();
});
