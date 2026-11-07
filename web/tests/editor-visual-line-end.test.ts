import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Details, DetailsBody, DetailsSummary } from "@/components/MemoEditor/Editor/editable-details";
import { MemoStarterKit } from "@/components/MemoEditor/Editor/starter-kit";
import { VisualLineEnd } from "@/components/MemoEditor/Editor/visual-line-end";

const editors: Editor[] = [];

function create(content = "<p>first line<br>second line</p>") {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [MemoStarterKit, Details, DetailsSummary, DetailsBody, VisualLineEnd],
    content,
  });
  editors.push(editor);
  editor.view.focus();
  const selection = document.getSelection()!;
  const modify = vi.fn();
  Object.defineProperty(selection, "modify", { configurable: true, value: modify });
  return { editor, selection, modify };
}

function pressEnd(editor: Editor, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true, ...modifiers });
  editor.view.dom.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    const element = editor.options.element as HTMLElement;
    editor.destroy();
    element.remove();
  }
  const selection = document.getSelection();
  if (selection) Reflect.deleteProperty(selection, "modify");
});

describe("visual line End shortcut", () => {
  it.each([
    ["paragraph", "<p>first line<br>second line</p>", "p"],
    ["code", "<pre><code>first line\nsecond line</code></pre>", "code"],
    ["folding title", "<details><summary>Title</summary><p>Body</p></details>", "summary"],
    ["folding body", "<details><summary>Title</summary><p>Body</p></details>", "p"],
  ])("uses the native visual line boundary in a %s without changing content", (_name, content, selector) => {
    const { editor, selection, modify } = create(content);
    selection.collapse(editor.view.dom.querySelector(selector)!.firstChild, 1);
    const before = editor.getJSON();

    expect(pressEnd(editor).defaultPrevented).toBe(true);
    expect(modify).toHaveBeenCalledExactlyOnceWith("move", "forward", "lineboundary");
    expect(editor.getJSON()).toEqual(before);
  });

  it.each(["shiftKey", "ctrlKey", "metaKey", "altKey"])("leaves %s-End to existing behavior", (modifier) => {
    const { editor, modify } = create();
    pressEnd(editor, { [modifier]: true });
    expect(modify).not.toHaveBeenCalled();
  });

  it("lets the native selection change reach ProseMirror before subsequent typing", async () => {
    const { editor, selection, modify } = create();
    const text = editor.view.dom.querySelector("p")!.firstChild!;
    modify.mockImplementation(() => selection.collapse(text, 10));

    pressEnd(editor);
    document.dispatchEvent(new Event("selectionchange"));
    await vi.waitFor(() => expect(editor.state.selection.head).toBe(11));
    editor.commands.insertContent("!");

    expect(editor.getHTML()).toBe("<p>first line!<br>second line</p>");
  });

  it("does not override IME composition", () => {
    const { editor, modify } = create();
    Object.defineProperty(editor.view, "composing", { configurable: true, value: true });
    expect(pressEnd(editor).defaultPrevented).toBe(false);
    expect(modify).not.toHaveBeenCalled();
  });

  it("does not move a selection outside the editor", () => {
    const { editor, selection, modify } = create();
    selection.collapse(document.body, 0);
    expect(pressEnd(editor).defaultPrevented).toBe(false);
    expect(modify).not.toHaveBeenCalled();
  });

  it("leaves native behavior available without Selection.modify", () => {
    const { editor, selection } = create();
    Reflect.deleteProperty(selection, "modify");
    expect(pressEnd(editor).defaultPrevented).toBe(false);
  });

  it("does not override a read-only editor", () => {
    const { editor, modify } = create();
    editor.setEditable(false);
    expect(pressEnd(editor).defaultPrevented).toBe(false);
    expect(modify).not.toHaveBeenCalled();
  });
});
