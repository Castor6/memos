const preferences = vi.hoisted(() => ({ enterToSave: false }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ userGeneralSetting: preferences }) }));

import { act, fireEvent, render } from "@testing-library/react";
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
    expect(body.querySelector("details summary")).toHaveTextContent("Title");
    fireEvent.keyDown(body, { key: "Enter", code: "Enter", shiftKey: true });
    act(() => ref.current!.insertText!("Body"));
    expect(body.querySelector("[data-details-body]")).toHaveTextContent("Body");
    fireEvent.keyDown(body, { key: "ArrowDown", code: "ArrowDown" });
    act(() => ref.current!.insertText!("Continue"));
    expect(body.querySelector("details + p")).toHaveTextContent("Continue");
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
    expect(body.querySelector("details summary")).toHaveTextContent("Title");
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
