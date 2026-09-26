import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type ActiveFormatState, EMPTY_ACTIVE_FORMATS } from "@/components/MemoEditor/formatting/commands";
import { FormattingToolbar } from "@/components/MemoEditor/Toolbar/FormattingToolbar";
import type { EditorController } from "@/components/MemoEditor/types/editorController";

vi.mock("@/utils/i18n", () => ({ useTranslate: () => (key: string) => key }));

// Base UI menus reach for layout/pointer APIs jsdom doesn't implement.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

function makeController(opts: { active?: Partial<ActiveFormatState>; getSelectedText?: () => string } = {}) {
  const run = vi.fn();
  const captureSelection = vi.fn();
  const restoreSelection = vi.fn();
  const activeFormats: ActiveFormatState = { ...EMPTY_ACTIVE_FORMATS, ...opts.active };
  const controller: EditorController = {
    focus: () => {},
    hasFocus: () => false,
    isEmpty: () => true,
    getMarkdown: () => "",
    setMarkdown: () => {},
    insertMarkdown: vi.fn(),
    scrollToCursor: () => {},
    selectAll: () => {},
    formatting: {
      run,
      captureSelection,
      restoreSelection,
      getActiveFormats: () => activeFormats,
      getSelectedText: opts.getSelectedText ?? (() => ""),
      subscribe: () => () => {},
    },
  };
  return { controller, run, captureSelection, restoreSelection };
}

function renderToolbar(controller: EditorController, onExit = vi.fn()) {
  const ref = createRef<EditorController>();
  ref.current = controller;
  render(<FormattingToolbar controllerRef={ref} onExit={onExit} />);
  return { onExit };
}

describe("FormattingToolbar", () => {
  it("runs the bold command when the bold button is clicked", () => {
    const { controller, run, captureSelection, restoreSelection } = makeController();
    renderToolbar(controller);
    fireEvent.click(screen.getByRole("button", { name: "文字" }));
    expect(captureSelection).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("menuitem", { name: "加粗" }));
    expect(restoreSelection).toHaveBeenCalled();
    expect(restoreSelection.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]);
    expect(run).toHaveBeenCalledWith("bold");
  });

  it("runs the heading command when a heading level is chosen", () => {
    const { controller, run } = makeController();
    renderToolbar(controller);
    fireEvent.click(screen.getByRole("button", { name: "段落" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "标题 2" }));
    expect(run).toHaveBeenCalledWith("heading2");
  });

  it("shows active marks without exposing every formatting action in the bottom row", () => {
    const { controller } = makeController({ active: { underline: true } });
    renderToolbar(controller);
    expect(screen.queryByRole("button", { name: "下划线" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "文字" }));
    expect(screen.getByRole("menuitem", { name: /下划线.*已应用/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "清除文字格式" })).toBeInTheDocument();
  });

  it("calls onExit when the exit button is clicked", () => {
    const { controller } = makeController();
    const { onExit } = renderToolbar(controller);
    fireEvent.click(screen.getByRole("button", { name: "退出专注模式" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
