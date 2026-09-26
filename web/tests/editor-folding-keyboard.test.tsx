const preferences = vi.hoisted(() => ({ enterToSave: false }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ userGeneralSetting: preferences }) }));

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Editor from "@/components/MemoEditor/Editor";
import type { EditorController } from "@/components/MemoEditor/types/editorController";

const mount = (initialContent = "", readOnly = false) => {
  const ref = createRef<EditorController>();
  const onSubmit = vi.fn();
  const onContentChange = vi.fn();
  const props = { className: "", initialContent, readOnly, placeholder: "memo", onContentChange, onFiles: vi.fn(), onSubmit };
  const view = render(<Editor ref={ref} {...props} />);
  const body = view.container.querySelector(".rich-editor") as HTMLElement;
  return {
    ...view,
    ref,
    body,
    onSubmit,
    onContentChange,
    rerenderEditor: (next: Partial<typeof props>) => view.rerender(<Editor ref={ref} {...props} {...next} />),
  };
};

afterEach(() => {
  preferences.enterToSave = false;
  vi.unstubAllGlobals();
});

describe("mounted rich editor keyboard flows", () => {
  it("inserts a fold, types its title, enters its body with Shift+Enter, then exits with ArrowDown", () => {
    const { ref, body } = mount();
    act(() => ref.current!.formatting!.run("insertDetails"));
    act(() => ref.current!.insertText!("Title"));
    expect(body.querySelector(".editable-details summary")).toHaveTextContent("Title");
    fireEvent.keyDown(body, { key: "Enter", code: "Enter", shiftKey: true });
    act(() => ref.current!.insertText!("Body"));
    expect(body.querySelector("[data-details-body]")).toHaveTextContent("Body");
    fireEvent.keyDown(body, { key: "ArrowDown", code: "ArrowDown" });
    act(() => ref.current!.insertText!("Continue"));
    expect(body.querySelector(".editable-details + p")).toHaveTextContent("Continue");
  });

  it("folds without changing Markdown and reopens when the caret enters the body", () => {
    const { ref, body, onContentChange } = mount();
    act(() => ref.current!.formatting!.run("insertDetails"));
    act(() => ref.current!.insertText!("Title"));
    fireEvent.keyDown(body, { key: "Enter", code: "Enter", shiftKey: true });
    act(() => ref.current!.insertText!("Body"));
    const fold = body.querySelector(".editable-details")!;
    const before = ref.current!.getMarkdown();
    onContentChange.mockClear();
    fireEvent.click(fold.querySelector(".memo-details-close")!);
    expect(fold).toHaveAttribute("data-expanded", "false");
    expect(ref.current!.getMarkdown()).toBe(before);
    expect(onContentChange).not.toHaveBeenCalled();
    // Closing moves the selection to the title, so typing cannot edit hidden text.
    act(() => ref.current!.insertText!("New "));
    expect(fold.querySelector("summary")).toHaveTextContent("New Title");
    expect(fold).toHaveAttribute("data-expanded", "false");
    fireEvent.keyDown(body, { key: "Enter", code: "Enter", shiftKey: true });
    expect(fold).toHaveAttribute("data-expanded", "true");
    act(() => ref.current!.insertText!("More "));
    expect(fold.querySelector("[data-details-body]")).toHaveTextContent("More Body");
    fireEvent.click(fold.querySelector(".memo-details-toggle")!);
    expect(fold).toHaveAttribute("data-expanded", "false");
    fireEvent.click(fold.querySelector(".memo-details-toggle")!);
    expect(fold).toHaveAttribute("data-expanded", "true");
    const saved = ref.current!.getMarkdown();
    act(() => ref.current!.setMarkdown(saved));
    expect(ref.current!.getMarkdown()).toBe(saved);
    expect(body.querySelector(".editable-details summary")).toHaveTextContent("New Title");
  });

  it("shows the compact command order and keeps the selection when applying strikethrough", async () => {
    const { ref, body } = mount("Selected text");
    act(() => ref.current!.focus());
    act(() => ref.current!.selectAll());
    await waitFor(() => expect(screen.getByRole("toolbar", { name: "选中文字格式" })).toBeVisible());
    for (const name of ["加粗", "斜体", "下划线", "删除线", "高亮", "链接"])
      expect(screen.getByRole("button", { name, exact: true })).toBeVisible();
    expect(screen.queryByRole("button", { name: "更多文字格式" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "行内代码", exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清除文字格式", exact: true })).not.toBeInTheDocument();
    expect([...screen.getByRole("toolbar", { name: "选中文字格式" }).querySelectorAll("button")].map((button) => button.getAttribute("aria-label")))
      .toEqual(["加粗", "斜体", "下划线", "删除线", "高亮", "链接"]);
    const strike = screen.getByRole("button", { name: "删除线", exact: true });
    fireEvent.mouseDown(strike);
    fireEvent.click(strike);
    expect(body.querySelector("s")).toHaveTextContent("Selected text");
    expect(ref.current!.getMarkdown()).toContain("~~Selected text~~");
  });

  it("honors Enter-to-save while Shift+Enter enters the folding body; Ctrl/Cmd+Enter invokes submit in normal mode", () => {
    preferences.enterToSave = true;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    const { ref, body, onSubmit, rerenderEditor } = mount();
    act(() => ref.current!.formatting!.run("insertDetails"));
    act(() => ref.current!.insertText!("Title"));
    fireEvent.keyDown(body, { key: "Enter", code: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(body.querySelector("[data-details-body]")).toHaveTextContent("");
    fireEvent.keyDown(body, { key: "Enter", code: "Enter", shiftKey: true });
    act(() => ref.current!.insertText!("Body"));
    expect(body.querySelector("[data-details-body]")).toHaveTextContent("Body");
    preferences.enterToSave = false;
    rerenderEditor({});
    fireEvent.keyDown(body, { key: "Enter", code: "Enter", ctrlKey: true });
    fireEvent.keyDown(body, { key: "Enter", code: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(3);
  });

  it("lets a plain Enter leave the title for the body when Enter-to-save is off", () => {
    const { ref, body, onSubmit } = mount();
    act(() => ref.current!.formatting!.run("insertDetails"));
    act(() => ref.current!.insertText!("Title"));
    fireEvent.keyDown(body, { key: "Enter", code: "Enter" });
    act(() => ref.current!.insertText!("Body"));
    expect(body.querySelector("[data-details-body]")).toHaveTextContent("Body");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps task list Tab and Shift+Tab nesting functional", () => {
    const { ref, body } = mount("- [ ] First\n- [ ] Second");
    act(() => ref.current!.focus("end"));
    fireEvent.keyDown(body, { key: "Tab", code: "Tab" });
    expect(ref.current!.getMarkdown()).toMatch(/  - \[ \] Second/);
    fireEvent.keyDown(body, { key: "Tab", code: "Tab", shiftKey: true });
    expect(ref.current!.getMarkdown()).toContain("- [ ] First\n- [ ] Second");
  });

  it("round trips underline through controller Markdown and remains editable after reload", () => {
    const { ref, body } = mount("<u>Under</u>");
    const saved = ref.current!.getMarkdown();
    expect(saved).toContain("<u>Under</u>");
    act(() => ref.current!.setMarkdown(saved));
    expect(body.querySelector("u")).toHaveTextContent("Under");
    act(() => ref.current!.focus("end"));
    act(() => ref.current!.insertText!(" more"));
    expect(ref.current!.getMarkdown()).toContain("more");
  });

  it("converts selected complete details source and preserves an incomplete source", () => {
    const { ref, body } = mount();
    const source = "<details><summary>Title</summary>Body</details>";
    act(() => ref.current!.insertText!(source));
    act(() => ref.current!.selectAll());
    expect(ref.current!.formatting!.canRun!("convertDetails")).toBe(true);
    act(() => ref.current!.formatting!.run("convertDetails"));
    expect(body.querySelector(".editable-details summary")).toHaveTextContent("Title");
    act(() => ref.current!.setMarkdown("<details><summary>Incomplete"));
    act(() => ref.current!.selectAll());
    expect(ref.current!.formatting!.canRun!("convertDetails")).toBe(false);
    const original = ref.current!.getMarkdown();
    act(() => ref.current!.formatting!.run("convertDetails"));
    expect(ref.current!.getMarkdown()).toBe(original);
  });

  it("ignores late formatting commands while saving makes the editor read only", () => {
    const { ref, body, rerenderEditor } = mount("draft");
    act(() => rerenderEditor({ readOnly: true }));
    expect(body).toHaveAttribute("contenteditable", "false");
    const before = ref.current!.getMarkdown();
    act(() => ref.current!.formatting!.run("insertDetails"));
    act(() => ref.current!.formatting!.run("underline"));
    expect(ref.current!.getMarkdown()).toBe(before);
  });
});
