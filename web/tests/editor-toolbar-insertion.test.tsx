import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { BoldIcon } from "lucide-react";
import { createRichFormattingController } from "@/components/MemoEditor/Editor/rich-formatting";
import { CommandMenu } from "@/components/MemoEditor/Toolbar/CommandMenu";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EMPTY_ACTIVE_FORMATS } from "@/components/MemoEditor/formatting/commands";
import { LinkEditorDialog } from "@/components/MemoEditor/Toolbar/LinkEditorDialog";
import QuickTools from "@/components/MemoEditor/Toolbar/QuickTools";
import type { EditorController, FormattingController } from "@/components/MemoEditor/types/editorController";

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ userGeneralSetting: { commonWords: ["Alpha", "Beta"] } }) }));
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});
function makeFormatting(): FormattingController {
  return {
    run: vi.fn(),
    captureSelection: vi.fn(),
    restoreSelection: vi.fn(),
    getActiveFormats: () => EMPTY_ACTIVE_FORMATS,
    subscribe: () => () => {},
  };
}

describe("editor toolbar insertion", () => {
  it("preserves the insertion point while searching common words", () => {
    const formatting = makeFormatting();
    const insertText = vi.fn();
    const ref = createRef<EditorController>();
    ref.current = { formatting, insertText, focus: vi.fn() } as unknown as EditorController;
    render(<QuickTools controllerRef={ref} />);
    fireEvent.click(screen.getByRole("button", { name: "常用词" }));
    expect(formatting.captureSelection).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索常用词" }), { target: { value: "al" } });
    expect(screen.queryByRole("button", { name: "Beta" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(formatting.restoreSelection).toHaveBeenCalledOnce();
    expect(insertText).toHaveBeenCalledWith("Alpha");
    expect(vi.mocked(formatting.restoreSelection!).mock.invocationCallOrder[0]).toBeLessThan(insertText.mock.invocationCallOrder[0]);
  });

  it("restores the selected text after typing a link target", () => {
    const controller = makeFormatting();
    const onOpenChange = vi.fn();
    render(<LinkEditorDialog open onOpenChange={onOpenChange} controller={controller} />);
    fireEvent.change(screen.getByRole("textbox", { name: "链接地址" }), { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "插入" }));
    expect(controller.restoreSelection).toHaveBeenCalledOnce();
    expect(controller.run).toHaveBeenCalledWith("link", { url: "https://example.com" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

function richEditor() {
  const editor = new Editor({ extensions: [StarterKit], content: "<p>first second</p>" });
  editors.push(editor);
  editor.commands.setTextSelection({ from: 1, to: 6 });
  const formatting = createRichFormattingController(editor, () => false);
  const ref = createRef<EditorController>();
  ref.current = { formatting, focus: () => editor.commands.focus() } as EditorController;
  return { editor, formatting, ref };
}
function formatNewSelection(editor: Editor, formatting: FormattingController) {
  editor.commands.setTextSelection({ from: 7, to: 13 });
  formatting.run("bold");
  expect(editor.getHTML()).toBe("<p>first <strong>second</strong></p>");
}

describe("cancelled toolbar selection lifecycle", () => {
  it("does not apply a later command to the selection from a cancelled command menu", async () => {
    const { editor, formatting } = richEditor();
    render(<CommandMenu label="格式" icon={BoldIcon} items={[]} controller={formatting} active={EMPTY_ACTIVE_FORMATS} />);
    fireEvent.click(screen.getByRole("button", { name: "格式" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    formatNewSelection(editor, formatting);
  });

  it("does not retain the old insertion point when common-word search is cancelled", async () => {
    const { editor, formatting, ref } = richEditor();
    render(<QuickTools controllerRef={ref} />);
    fireEvent.click(screen.getByRole("button", { name: "常用词" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "搜索常用词" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
    formatNewSelection(editor, formatting);
  });

  it("consumes the saved selection when the link dialog is cancelled", () => {
    const { editor, formatting } = richEditor();
    formatting.captureSelection?.();
    render(<LinkEditorDialog open onOpenChange={() => {}} controller={formatting} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    formatNewSelection(editor, formatting);
  });
});
