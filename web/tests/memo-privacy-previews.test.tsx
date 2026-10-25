import { create } from "@bufbuild/protobuf";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LinkMemoDialog } from "@/components/MemoMetadata/Relation/LinkMemoDialog";
import MemoCommentListView from "@/components/MemoView/components/MemoCommentListView";
import { PrivateMemoVisibilityProvider, usePrivateMemoVisibility } from "@/contexts/PrivateMemoVisibilityContext";
import { type Memo, MemoSchema } from "@/types/proto/api/v1/memo_service_pb";

const data = vi.hoisted(() => ({ memo: {} as Memo, comments: [] as Memo[] }));

vi.mock("@/components/MemoPreview", () => ({
  MemoPreview: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogClose: () => null,
}));
vi.mock("@/components/MemoView/MemoViewContext", () => ({
  useMemoViewContext: () => ({ memo: data.memo }),
  useMemoViewDerived: () => ({ isInMemoDetailPage: false, commentAmount: data.comments.length }),
}));
vi.mock("@/hooks/useMemoQueries", () => ({ useMemoComments: () => ({ data: { memos: data.comments } }) }));
vi.mock("@/hooks/useNearViewport", () => ({ useNearViewport: () => ({ ref: () => {}, isNearViewport: true }) }));
vi.mock("@/hooks/useUserQueries", () => ({ useUsersByNames: () => ({ data: new Map() }) }));
vi.mock("@/utils/i18n", () => ({ useTranslate: () => (key: string) => key }));

function Controls() {
  const { toggleAll } = usePrivateMemoVisibility();
  const location = useLocation();
  return (
    <>
      <button type="button" onClick={toggleAll}>
        Toggle all
      </button>
      <output data-testid="location">
        {location.pathname}
        {location.hash}
      </output>
    </>
  );
}

function setup(children: ReactNode) {
  return render(
    <MemoryRouter>
      <PrivateMemoVisibilityProvider>
        <Controls />
        {children}
      </PrivateMemoVisibilityProvider>
    </MemoryRouter>,
  );
}

describe("private memo previews", () => {
  beforeEach(() => {
    data.memo = create(MemoSchema, { name: "memos/parent" });
    data.comments = [];
  });

  it("reveals a private search result before selecting it for an inline reference", () => {
    const memo = create(MemoSchema, { name: "memos/private", content: "Private reference", mcpHidden: true });
    const onSelect = vi.fn();
    const { container } = setup(
      <LinkMemoDialog
        open
        onOpenChange={vi.fn()}
        searchText=""
        onSearchChange={vi.fn()}
        filteredMemos={[memo]}
        isFetching={false}
        onSelectMemo={onSelect}
        isAlreadyLinked={() => false}
      />,
    );
    expect(screen.getByText("Private reference").closest("[inert]")).not.toBeNull();
    const reveal = screen.getByRole("button", { name: "memo.mcp-privacy.show-content" });
    expect(reveal.parentElement?.closest("a, button")).toBeNull();
    fireEvent.click(reveal);
    expect(onSelect).not.toHaveBeenCalled();
    expect(container.querySelector('[data-content-hidden="true"]')).toBeNull();
    fireEvent.click(screen.getByText("Private reference"));
    expect(onSelect).toHaveBeenCalledWith(memo);
  });

  it("reveals a private comment without navigating, then lets its link work", () => {
    data.comments = [create(MemoSchema, { name: "memos/comment", snippet: "Private comment", mcpHidden: true })];
    setup(<MemoCommentListView />);
    const reveal = screen.getByRole("button", { name: "memo.mcp-privacy.show-content" });
    expect(reveal.parentElement?.closest("a, button")).toBeNull();
    fireEvent.click(reveal);
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    fireEvent.click(screen.getByRole("link", { name: "Private comment" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/memos/parent#comment");
  });

  it("conceals all comment previews with their private parent and resets after hide-all", () => {
    data.memo = create(MemoSchema, { name: "memos/parent", mcpHidden: true });
    data.comments = [create(MemoSchema, { name: "memos/comment", snippet: "Parent-related comment" })];
    const { container } = setup(<MemoCommentListView />);
    expect(screen.getByText("Parent-related comment").closest("[inert]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "memo.mcp-privacy.show-content" }));
    expect(container.querySelector('[data-content-hidden="true"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle all" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle all" }));
    expect(screen.getByText("Parent-related comment").closest("[inert]")).not.toBeNull();
  });
});
