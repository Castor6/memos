import { create } from "@bufbuild/protobuf";
import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it.each(["outside click", "Escape"])("keeps the pointer anchor through the exit animation after %s", async (dismissal) => {
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1024);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(768);
    render(<Card />);
    fireEvent.contextMenu(screen.getByText("正文"), { clientX: 300, clientY: 180 });
    const popup = await screen.findByRole("menu");
    await waitFor(() => expect(popup).not.toHaveAttribute("data-starting-style"));
    const positioner = popup.parentElement!;
    const position = positioner.style.transform;
    const alignment = popup.getAttribute("data-align");
    expect(alignment).toBe("start");
    let finishAnimation!: () => void;
    const finished = new Promise<void>((resolve) => {
      finishAnimation = resolve;
    });
    const getAnimations = vi.fn(() => [{ finished }]);
    Object.defineProperty(popup, "getAnimations", { value: getAnimations, configurable: true });

    if (dismissal === "Escape") {
      fireEvent.keyDown(popup, { key: "Escape" });
    } else {
      fireEvent.mouseDown(document.body);
      fireEvent.mouseUp(document.body);
      fireEvent.click(document.body);
    }
    await waitFor(() => expect(getAnimations).toHaveBeenCalled());
    expect(popup).toBeInTheDocument();
    expect(popup).toHaveAttribute("data-ending-style");
    expect(popup).toHaveAttribute("data-align", alignment);
    expect(positioner.style.transform).toBe(position);

    await act(async () => finishAnimation());
    await waitFor(() => expect(popup).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "笔记操作" }));
    const buttonPopup = await screen.findByRole("menu");
    await waitFor(() => expect(buttonPopup.parentElement!.style.transform).not.toBe(position));
    fireEvent.keyDown(buttonPopup, { key: "Escape" });
    await waitFor(() => expect(buttonPopup).not.toBeInTheDocument());
    fireEvent.contextMenu(screen.getByText("正文"), { clientX: 480, clientY: 240 });
    const reopenedPopup = await screen.findByRole("menu");
    await waitFor(() => expect(reopenedPopup.parentElement!.style.transform).not.toBe(position));
  });

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
