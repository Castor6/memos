import { Editor } from "@tiptap/core";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import {
  Details,
  DetailsBody,
  DetailsSummary,
  insertDetails,
  parseDetailsSource,
  convertSelectionToDetails,
  exitDetails,
} from "@/components/MemoEditor/Editor/editable-details";
import { MarkdownUnderline } from "@/components/MemoEditor/Editor/markdown-underline";
import { prepareMarkdown, PreservedContent } from "@/components/MemoEditor/Editor/preserved-content";

const editors: Editor[] = [];
const create = (markdown: string) => {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ underline: false, trailingNode: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Details,
      DetailsSummary,
      DetailsBody,
      MarkdownUnderline,
      PreservedContent,
      Markdown,
    ],
    content: prepareMarkdown(markdown),
    contentType: "markdown",
  });
  editors.push(editor);
  return editor;
};
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("editable folding blocks", () => {
  it("loads and saves single-line legacy HTML with editable title and body", () => {
    const editor = create("<details><summary>Title</summary><p>Hello <strong>world</strong></p></details>");
    expect(editor.getJSON().content?.[0].type).toBe("details");
    expect(editor.getJSON().content?.[0].content?.[0].type).toBe("detailsSummary");
    expect(editor.getHTML()).toContain("open");
    expect(editor.getMarkdown()).toContain("Hello **world**");
    expect(editor.getMarkdown()).not.toContain("open");
    const reloaded = create(editor.getMarkdown());
    expect(reloaded.getJSON()).toEqual(editor.getJSON());
  });
  it("retains nested completed tasks across reloads", () => {
    const source = "<details>\n<summary>Tasks</summary>\n\n- [x] Finished\n  - [ ] Child\n- [ ] Next\n\n</details>";
    const editor = create(source);
    expect(editor.getHTML()).toContain('data-checked="true"');
    expect(editor.getHTML()).toContain('data-type="taskList"');
    expect(create(editor.getMarkdown()).getJSON()).toEqual(editor.getJSON());
  });
  it("preserves an unsupported entire block including Markdown after blank lines", () => {
    const source = '<details>\n<summary>Title</summary>\n\nBefore\n\n<iframe src="https://example.com"></iframe>\n\nAfter\n</details>';
    const editor = create(source);
    expect(editor.getJSON().content?.[0].type).toBe("preservedContent");
    expect(editor.getMarkdown()).toBe(source);
  });
  it("does not interpret examples in fenced or inline code", () => {
    const source = "```html\n<details><summary>Example</summary>Body</details>\n```\n\n`<details><summary>X</summary>Y</details>`";
    const editor = create(source);
    expect(editor.getJSON().content?.[0].type).toBe("codeBlock");
    expect(editor.getMarkdown()).toContain("<details><summary>Example</summary>Body</details>");
    expect(editor.getJSON().content?.some((node) => node.type === "details")).toBe(false);
  });
  it("inserts editable title, body, and a following paragraph", () => {
    const editor = create("");
    expect(insertDetails(editor)).toBe(true);
    expect(editor.state.selection.$from.parent.type.name).toBe("detailsSummary");
    editor.commands.insertContent("A title");
    expect(editor.getMarkdown()).toContain("<summary>A title</summary>");
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
  });
  it("converts explicitly selected source text", () => {
    const editor = create("");
    const source = "<details><summary>Title</summary>Body</details>";
    editor.commands.insertContent({ type: "paragraph", content: [{ type: "text", text: source }] });
    editor.commands.setTextSelection({ from: 1, to: source.length + 1 });
    expect(convertSelectionToDetails(editor)).toBe(true);
    expect(editor.getJSON().content?.some((node) => node.type === "details")).toBe(true);
    expect(parseDetailsSource("<details><summary>Incomplete")).toBeNull();
  });
  it("keeps code examples and unsupported math within editable details", () => {
    const source = "<details>\n<summary>Example</summary>\n\n```html\n<span>Literal</span>\n```\n\n$$\nx^2\n$$\n\n</details>";
    const editor = create(source);
    expect(editor.getJSON().content?.[0].type).toBe("details");
    expect(editor.getMarkdown()).toContain("<span>Literal</span>");
    expect(editor.getMarkdown()).toContain("x^2");
    expect(create(editor.getMarkdown()).getJSON()).toEqual(editor.getJSON());
  });
  it("preserves literal Markdown characters and encoded HTML in titles and HTML bodies", () => {
    const editor = create(
      "<details><summary>Literal *stars* [link](https://example.com)</summary><p>Literal *stars* &lt;img src=x&gt;</p></details>",
    );
    expect(editor.getHTML()).not.toContain("<em>");
    expect(editor.getHTML()).not.toContain("<img");
    expect(editor.getMarkdown()).toContain("&lt;img");
    expect(create(editor.getMarkdown()).getJSON()).toEqual(editor.getJSON());
  });
  it("retains a valid empty body when only the title has been filled", () => {
    const editor = create("");
    insertDetails(editor);
    editor.commands.insertContent("Title");
    const reloaded = create(editor.getMarkdown());
    expect(reloaded.getJSON().content?.[0].content?.[1].content?.[0].type).toBe("paragraph");
    expect(() => reloaded.state.doc.check()).not.toThrow();
  });
  it("treats malformed internal token examples as normal code", () => {
    const editor = create("```memos-editable-details\n%\n```");
    expect(editor.getJSON().content?.[0].type).toBe("codeBlock");
  });
  it("exits the end of historical folding bodies and reuses a following paragraph", () => {
    for (const suffix of ["", "\n\nExisting"]) {
      const editor = create("<details><summary>Title</summary>Body</details>" + suffix);
      let end = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "text" && node.text === "Body") end = pos + node.nodeSize;
      });
      editor.commands.setTextSelection(end);
      expect(exitDetails(editor)).toBe(true);
      expect(editor.state.doc.childCount).toBe(2);
      expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
      editor.commands.insertContent("Continue");
      expect(editor.getMarkdown()).toContain(suffix ? "ContinueExisting" : "Continue");
    }
  });
  it("preserves containers and unknown head or comment content without losing source", () => {
    for (const source of [
      "> <details><summary>Title</summary>Body</details>",
      "- <details><summary>Title</summary>Body</details>",
      "<details><summary>Title</summary><!-- comment --></details>",
      "<details><summary>Title</summary><style>p { color:red }</style><p>Body</p></details>",
    ]) {
      const editor = create(source);
      expect(editor.getJSON().content?.[0].type).toBe("preservedContent");
      expect(editor.getMarkdown()).toBe(source);
    }
  });
  it("inserts beside an existing task list without changing its checked state or nesting", () => {
    const editor = create("- [x] Existing\n  - [ ] Child");
    editor.commands.setTextSelection(4);
    const list = editor.getJSON().content?.[0];
    expect(insertDetails(editor)).toBe(true);
    expect(editor.getJSON().content?.[0]).toEqual(list);
    expect(editor.getJSON().content?.[1].type).toBe("details");
    editor.commands.insertContent("Title");
    const reloaded = create(editor.getMarkdown());
    expect(reloaded.getJSON().content?.[0]).toEqual(list);
    expect(reloaded.getJSON().content?.[1].type).toBe("details");
  });
  it("creates editable checked tasks inside a new folding body and reloads them", () => {
    const editor = create("");
    insertDetails(editor);
    editor.commands.insertContent("Tasks");
    let bodyPosition = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "detailsBody") bodyPosition = pos + 2;
    });
    editor.commands.setTextSelection(bodyPosition);
    editor.commands.toggleTaskList();
    editor.commands.insertContent("Task inside fold");
    editor.commands.updateAttributes("taskItem", { checked: true });
    const reloaded = create(editor.getMarkdown());
    expect(reloaded.getJSON().content?.[0].type).toBe("details");
    expect(reloaded.getJSON().content?.[0].content?.[1].content?.[0].type).toBe("taskList");
    expect(reloaded.getHTML()).toContain('data-checked="true"');
    expect(reloaded.state.doc.textContent).toContain("Task inside fold");
  });
  it("supports basic safe HTML and retains unsupported attributes", () => {
    expect(parseDetailsSource("<details><summary>Title</summary><ul><li>First</li><li>Second</li></ul></details>")?.body).toContain(
      "- First",
    );
    expect(parseDetailsSource('<details><summary>Title</summary><p style="color:red">Body</p></details>')).toBeNull();
  });
});

describe("HTML underline", () => {
  it("round trips underline mixed with bold and links", () => {
    const editor = create("Before <u>under **bold** [link](https://example.com)</u> after");
    expect(editor.getHTML()).toContain("<u>");
    expect(editor.getJSON().content?.[0].type).toBe("paragraph");
    expect(editor.getMarkdown()).toContain("<u>");
    expect(editor.getMarkdown()).not.toContain("++");
    expect(create(editor.getMarkdown()).getJSON()).toEqual(editor.getJSON());
  });
  it("supports underline starting a paragraph and keyboard-created underline", () => {
    const editor = create("<u>text</u>");
    expect(editor.getHTML()).toContain("<u>text</u>");
    editor.commands.selectAll();
    editor.commands.toggleUnderline();
    expect(editor.getMarkdown()).toBe("text");
    editor.commands.toggleUnderline();
    expect(editor.getMarkdown()).toBe("<u>text</u>");
  });
  it("keeps underlined paragraphs with literal currency editable", () => {
    const editor = create("Text <u>under</u> $5");
    expect(editor.getJSON().content?.[0].type).toBe("paragraph");
    expect(editor.getHTML()).toContain("<u>under</u>");
  });
  it("preserves unsupported HTML and math outside details", () => {
    const source = "<aside>Legacy</aside>\n\n$$\nx^2\n$$";
    expect(create(source).getMarkdown()).toBe(source);
  });
});
