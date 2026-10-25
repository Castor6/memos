import { create } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import RelationCard from "@/components/MemoMetadata/Relation/RelationCard";
import { useResolvedRelationMemos } from "@/components/MemoMetadata/Relation/useResolvedRelationMemos";
import { PrivateMemoVisibilityProvider } from "@/contexts/PrivateMemoVisibilityContext";
import { MemoSchema } from "@/types/proto/api/v1/memo_service_pb";

const fetchMemo = vi.hoisted(() => vi.fn());
vi.mock("@/utils/i18n", () => ({ useTranslate: () => (key: string) => key }));
vi.mock("@/hooks/useMemoQueries", () => ({
  findMemoInCollectionQueries: () => undefined,
  memoDetailQueryOptions: (name: string) => ({ queryKey: ["memo", name], queryFn: fetchMemo }),
}));

const snapshot = { name: "memos/secret", snippet: "Private target summary" };
const Harness = () => {
  const resolved = useResolvedRelationMemos([snapshot.name]);
  const client = useQueryClient();
  const location = useLocation();
  return (
    <>
      <RelationCard memo={resolved[snapshot.name] ?? snapshot} />
      <output>{location.pathname}</output>
      <button onClick={() => client.setQueryData(["memo", snapshot.name], create(MemoSchema, { ...snapshot, mcpHidden: false }))}>
        Unprotect
      </button>
    </>
  );
};
const renderHarness = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <PrivateMemoVisibilityProvider>
          <Harness />
        </PrivateMemoVisibilityProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe("relation target privacy", () => {
  it("conceals snapshots while identity is loading or unavailable", async () => {
    let rejectRequest!: (reason: Error) => void;
    fetchMemo.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectRequest = reject;
        }),
    );
    const { container } = renderHarness();
    expect(screen.getByText(snapshot.snippet).closest("[inert]")).not.toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    rejectRequest(new Error("unavailable"));
    await waitFor(() => expect(container.querySelector("[data-relation-unresolved]")).not.toBeNull());
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("uses target privacy, reveals before navigation, and reacts to cached updates", async () => {
    fetchMemo.mockResolvedValue(create(MemoSchema, { ...snapshot, mcpHidden: true, updateTime: { seconds: 1n } }));
    const { container } = renderHarness();
    const reveal = await screen.findByRole("button", { name: "memo.mcp-privacy.show-content" });
    expect(screen.getByText(snapshot.snippet).closest("[inert]")).not.toBeNull();
    expect(reveal.parentElement?.closest("a")).toBeNull();
    fireEvent.click(reveal);
    expect(screen.getByRole("status")).toHaveTextContent("/");
    expect(container.querySelector('[data-content-hidden="true"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unprotect" }));
    await waitFor(() => expect(screen.getByRole("link")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("link"));
    expect(screen.getByRole("status")).toHaveTextContent("/memos/secret");
  });

  it("keeps share-token snapshots visible without needing private metadata", () => {
    render(
      <MemoryRouter initialEntries={["/memos/shares/token"]}>
        <RelationCard memo={snapshot} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link")).toHaveTextContent(snapshot.snippet);
    expect(screen.getByText(snapshot.snippet).closest("[inert]")).toBeNull();
  });
});
