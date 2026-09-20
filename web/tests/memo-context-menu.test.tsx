import { create } from "@bufbuild/protobuf";
import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MemoActionMenu from "@/components/MemoActionMenu/MemoActionMenu";
import { useMemoContextMenu } from "@/components/MemoView/hooks/useMemoContextMenu";
import { State } from "@/types/proto/api/v1/common_pb";
import { MemoSchema } from "@/types/proto/api/v1/memo_service_pb";

const edit = vi.hoisted(() => vi.fn());
vi.mock("@/utils/i18n", () => ({ useTranslate: () => (key: string) => key }));
vi.mock("@/components/MemoActionMenu/hooks", () => ({ useMemoActionHandlers: () => ({ handleEditMemoClick: edit }) }));

function Card({ readonly = false, archived = false }: { readonly?: boolean; archived?: boolean }) {
  const menu = useMemoContextMenu();
  const memo = create(MemoSchema, {
    name: "memos/test",
    state: archived ? State.ARCHIVED : State.NORMAL,
    isTodo: true,
    property: { hasTaskList: true, hasIncompleteTasks: true },
  });
  return (
    <article tabIndex={0} {...menu.handlers}>
      <span>正文</span>
      <a href="https://example.com">链接</a>
      <img alt="图片" src="/image.png" />
      <MemoActionMenu memo={memo} readonly={readonly} contextMenuPosition={menu.position} onContextMenuClose={menu.close} />
    </article>
  );
}

describe("memo card context menu", () => {
  it("opens the existing actions by right-click and executes edit", async () => {
    render(<Card />);
    const event = createEvent.contextMenu(screen.getByText("正文"), { clientX: 300, clientY: 180 });
    fireEvent(screen.getByText("正文"), event);
    expect(event.defaultPrevented).toBe(true);
    fireEvent.click(await screen.findByRole("menuitem", { name: "common.edit" }));
    expect(edit).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "笔记操作" }));
    expect(await screen.findByRole("menuitem", { name: "common.edit" })).toBeInTheDocument();
  });
  it("retains read-only and archived action restrictions", async () => {
    render(<Card readonly archived />);
    fireEvent.contextMenu(screen.getByText("正文"));
    expect(await screen.findByRole("menuitem", { name: "导出" })).toBeInTheDocument();
    for (const name of ["common.edit", "common.pin", "common.delete", "common.restore", "memo.task-actions.title"]) {
      expect(screen.queryByRole("menuitem", { name })).toBeNull();
    }
  });
  it("keeps native menus for links, images and selected text", () => {
    render(<Card />);
    for (const element of [screen.getByRole("link"), screen.getByAltText("图片")]) {
      const event = createEvent.contextMenu(element);
      fireEvent(element, event);
      expect(event.defaultPrevented).toBe(false);
    }
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "选择的文字" } as Selection);
    const event = createEvent.contextMenu(screen.getByText("正文"));
    fireEvent(screen.getByText("正文"), event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
