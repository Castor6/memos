import { Editor, type JSONContent } from "@tiptap/core";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MemoMarkdownRendererCore } from "@/components/MemoContent/MemoMarkdownRenderer";
import { Details, DetailsBody, DetailsSummary } from "@/components/MemoEditor/Editor/editable-details";
import { PreservedContent, prepareMarkdown } from "@/components/MemoEditor/Editor/preserved-content";
import { MemoStarterKit } from "@/components/MemoEditor/Editor/starter-kit";
import { validationService } from "@/components/MemoEditor/services/validationService";
import { createInitialState } from "@/components/MemoEditor/state/types";

const editors: Editor[] = [];
const paragraph = (text?: string): JSONContent => ({ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) });

function create(content: string | JSONContent) {
  const editor = new Editor({
    extensions: [
      MemoStarterKit.configure({ trailingNode: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Details,
      DetailsSummary,
      DetailsBody,
      PreservedContent,
      Markdown.configure({ markedOptions: { breaks: true } }),
    ],
    content: typeof content === "string" ? prepareMarkdown(content) : content,
    ...(typeof content === "string" ? { contentType: "markdown" as const } : {}),
  });
  editors.push(editor);
  return editor;
}

afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

describe("empty lines in rich memo content", () => {
  it("retains blank lines created by editing before, between, and after text", () => {
    const editor = create("First");
    editor.commands.setTextSelection(1);
    editor.commands.splitBlock();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.splitBlock();
    editor.commands.splitBlock();
    editor.commands.insertContent("Last");
    editor.commands.splitBlock();
    expect(editor.getHTML()).toBe("<p></p><p>First</p><p></p><p>Last</p><p></p>");
    const reloaded = create(editor.getMarkdown());
    expect(reloaded.getHTML()).toBe(editor.getHTML());
    expect(reloaded.getMarkdown()).toBe(editor.getMarkdown());
  });

  it("retains leading, consecutive middle, and trailing empty paragraphs through repeated saves", () => {
    let editor = create({
      type: "doc",
      content: [paragraph(), paragraph(), paragraph("First"), paragraph(), paragraph(), paragraph("Last"), paragraph(), paragraph()],
    });
    const original = editor.getJSON();
    const markdown = editor.getMarkdown();
    expect(markdown).toBe("&nbsp;\n\n&nbsp;\n\nFirst\n\n&nbsp;\n\n&nbsp;\n\nLast\n\n&nbsp;\n\n&nbsp;");
    for (let index = 0; index < 3; index++) {
      editor = create(editor.getMarkdown());
      expect(editor.getJSON()).toEqual(original);
      expect(editor.getMarkdown()).toBe(markdown);
    }

    const html = renderToStaticMarkup(<MemoMarkdownRendererCore content={markdown} resolvedMentionUsernames={new Set()} />);
    const document = new DOMParser().parseFromString(html, "text/html");
    expect([...document.querySelectorAll("p")].map((node) => node.textContent)).toEqual([
      "\u00a0",
      "\u00a0",
      "First",
      "\u00a0",
      "\u00a0",
      "Last",
      "\u00a0",
      "\u00a0",
    ]);
  });

  it("preserves editable empty lines inside a folding body", () => {
    const editor = create({
      type: "doc",
      content: [
        {
          type: "details",
          content: [
            { type: "detailsSummary", content: [{ type: "text", text: "Title" }] },
            { type: "detailsBody", content: [paragraph(), paragraph("Body"), paragraph(), paragraph()] },
          ],
        },
      ],
    });
    const original = editor.getJSON();
    const markdown = editor.getMarkdown();
    expect(create(markdown).getJSON()).toEqual(original);
    expect(create(create(markdown).getMarkdown()).getJSON()).toEqual(original);
  });

  it("keeps normal line breaks, checked lists, and code block whitespace unchanged", () => {
    for (const source of [
      "First\nSecond",
      "- [x] Done\n- [ ] Next",
      "```text\n\nFirst\n\n\nLast\n\n```",
      "`&nbsp;`",
      "```html\n&nbsp;\n```",
    ]) {
      const editor = create(source);
      const original = editor.getJSON();
      expect(create(editor.getMarkdown()).getJSON()).toEqual(original);
      expect(validationService.canSave({ ...createInitialState(), content: editor.getMarkdown() }).valid).toBe(true);
    }
  });

  it("retains empty paragraphs inside lists and quotes without changing their structure", () => {
    for (const container of [
      { type: "blockquote", content: [paragraph(), paragraph("Quoted"), paragraph()] },
      {
        type: "bulletList",
        content: [{ type: "listItem", content: [paragraph("Item"), paragraph(), paragraph("Continued")] }],
      },
      {
        type: "taskList",
        content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("Done"), paragraph(), paragraph("Continued")] }],
      },
    ]) {
      const editor = create({ type: "doc", content: [container] });
      const original = editor.getJSON();
      const reloaded = create(editor.getMarkdown());
      expect(reloaded.getJSON()).toEqual(original);
      expect(create(reloaded.getMarkdown()).getJSON()).toEqual(original);
    }
  });

  it("does not enable saving a memo made only of empty paragraphs", () => {
    const editor = create({ type: "doc", content: [paragraph(), paragraph(), paragraph()] });
    expect(validationService.canSave({ ...createInitialState(), content: editor.getMarkdown() }).valid).toBe(false);
    expect(validationService.canSave({ ...createInitialState(), content: "&amp;nbsp;" }).valid).toBe(true);
    const taskState = createInitialState();
    taskState.metadata.isTodo = true;
    const task = create({
      type: "doc",
      content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [paragraph()] }] }],
    });
    expect(validationService.canSave({ ...taskState, content: task.getMarkdown() }).valid).toBe(false);
  });

  it("preserves literal entity text typed in the editor", () => {
    const editor = create({ type: "doc", content: [paragraph("&nbsp;")] });
    expect(create(editor.getMarkdown()).getJSON()).toEqual(editor.getJSON());
    expect(validationService.canSave({ ...createInitialState(), content: editor.getMarkdown() }).valid).toBe(true);
  });
});
