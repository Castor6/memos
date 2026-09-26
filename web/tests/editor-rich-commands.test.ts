import { Editor } from "@tiptap/core";
import Highlight from "@tiptap/extension-highlight";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { createRichFormattingController } from "@/components/MemoEditor/Editor/rich-formatting";

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

function setup(content: string) {
  const editor = new Editor({ extensions: [StarterKit, Highlight, TaskList, TaskItem.configure({ nested: true })], content });
  editors.push(editor);
  const guard = { readOnly: false };
  return { editor, guard, controller: createRichFormattingController(editor, () => guard.readOnly) };
}

describe("rich formatting commands", () => {
  it("clears only text styles, preserving links, headings and checked tasks", () => {
    const { editor, controller } = setup(
      '<h2><a href="https://example.com"><strong>Title</strong></a></h2><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p><u>Checked</u></p></li></ul>',
    );
    editor.commands.selectAll();
    controller.run("clearFormatting");
    expect(editor.getHTML()).toContain("<h2>");
    expect(editor.getHTML()).toContain('href="https://example.com"');
    expect(editor.getHTML()).toContain('data-checked="true"');
    expect(editor.getHTML()).not.toContain("<strong>");
    expect(editor.getHTML()).not.toContain("<u>");
    expect(editor.getText()).toContain("Checked");
  });

  it("restores the original selection after a link dialog moves focus", () => {
    const { editor, controller } = setup("<p>target other</p>");
    editor.commands.setTextSelection({ from: 1, to: 7 });
    controller.captureSelection?.();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    controller.run("link", { url: "https://example.com" });
    expect(editor.getHTML()).toMatch(/href="https:\/\/example.com"[^>]*>target<\/a> other/);
  });

  it("maps a captured selection through document edits", () => {
    const { editor, controller } = setup("<p>target</p>");
    editor.commands.selectAll();
    editor.commands.setTextSelection({ from: 1, to: 7 });
    controller.captureSelection?.();
    editor.commands.insertContentAt(0, { type: "paragraph", content: [{ type: "text", text: "before" }] });
    controller.run("underline");
    expect(editor.getHTML()).toContain("<p>before</p><p><u>target</u></p>");
  });

  it("preserves preset text styles when a menu opens without a selection", () => {
    const { editor, controller } = setup("<p>start </p>");
    editor.commands.setTextSelection(7);
    controller.run("bold");
    controller.captureSelection?.();
    controller.restoreSelection?.();
    editor.commands.insertContent("next");
    expect(editor.getHTML()).toContain("<strong>next</strong>");
  });

  it("ignores late menu actions while saving", () => {
    const { editor, controller, guard } = setup("<p>unchanged</p>");
    editor.commands.selectAll();
    controller.captureSelection?.();
    guard.readOnly = true;
    controller.run("bold");
    controller.run("link", { url: "https://example.com" });
    expect(controller.canRun?.("underline")).toBe(false);
    expect(editor.getHTML()).toBe("<p>unchanged</p>");
  });
});
