const preferences = vi.hoisted(() => ({ enterToSave: false }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ userGeneralSetting: preferences }) }));
import { act, render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import Editor from "@/components/MemoEditor/Editor";
import { EditorProvider, useEditorContext, useEditorSelector } from "@/components/MemoEditor/state";
import { createInitialState } from "@/components/MemoEditor/state/types";
import type { EditorController } from "@/components/MemoEditor/types/editorController";

vi.mock("@/hooks/useUserQueries", () => ({
  useTagCounts: () => ({ data: {} }),
}));

describe("Editor", () => {
  it("keeps the successful save reset empty when the editor becomes editable again", () => {
    const ref = createRef<EditorController>();
    let store!: ReturnType<typeof useEditorContext>;
    const Harness = () => {
      store = useEditorContext();
      const content = useEditorSelector((state) => state.content);
      const saving = useEditorSelector((state) => state.ui.isLoading.saving);
      return (
        <Editor
          ref={ref}
          className="x"
          initialContent={content}
          readOnly={saving}
          placeholder="memo"
          onContentChange={(value) => store.dispatch(store.actions.updateContent(value))}
          onFiles={vi.fn()}
          onSubmit={vi.fn()}
        />
      );
    };
    const { container } = render(
      <EditorProvider initialEditorState={{ ...createInitialState(), content: "saved memo" }}>
        <Harness />
      </EditorProvider>,
    );
    act(() => store.dispatch(store.actions.setLoading("saving", true)));
    expect(container.querySelector(".rich-editor")).toHaveAttribute("contenteditable", "false");
    act(() => {
      store.dispatch(store.actions.reset());
      store.dispatch(store.actions.setLoading("saving", false));
    });
    expect(store.getState().content).toBe("");
    expect(ref.current?.getMarkdown()).toBe("");
    expect(container.querySelector(".rich-editor")).not.toHaveTextContent("saved memo");
    expect(container.querySelector(".rich-editor")).toHaveAttribute("contenteditable", "true");
  });

  it("disables editing and file paste while a save is pending, then restores editing", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const onFiles = vi.fn();
    const props = { className: "x", initialContent: "draft", placeholder: "memo", onContentChange: vi.fn(), onFiles, onSubmit: vi.fn() };
    const { container, rerender } = render(<Editor {...props} readOnly />);
    const body = container.querySelector(".rich-editor")!;
    expect(body).toHaveAttribute("contenteditable", "false");
    fireEvent.paste(body, { clipboardData: { files: [new File(["data"], "test.txt")], getData: () => "", types: [] } });
    expect(onFiles).not.toHaveBeenCalled();
    rerender(<Editor {...props} readOnly={false} />);
    expect(body).toHaveAttribute("contenteditable", "true");
    expect(body).toHaveTextContent("draft");
  });

  it("loads Markdown as rich content and preserves its structure", () => {
    const ref = createRef<EditorController>();
    render(
      <Editor
        ref={ref}
        className="x"
        initialContent={"# Title\n\n- a\n  1. b"}
        placeholder="memo"
        onContentChange={vi.fn()}
        onFiles={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(ref.current?.getMarkdown()).toContain("# Title");
    expect(document.querySelector(".rich-editor h1")).toHaveTextContent("Title");
    expect(document.querySelector(".rich-editor ol li")).toHaveTextContent("b");
  });

  it("emits changes through onContentChange", () => {
    const ref = createRef<EditorController>();
    const onChange = vi.fn();
    render(
      <Editor
        ref={ref}
        className="x"
        initialContent=""
        placeholder="memo"
        onContentChange={onChange}
        onFiles={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    ref.current?.setMarkdown("hello");
    expect(onChange).toHaveBeenCalledWith("hello");
  });

  it("reconfigures the placeholder when its translation changes", () => {
    const props = {
      className: "x",
      initialContent: "",
      onContentChange: vi.fn(),
      onFiles: vi.fn(),
      onSubmit: vi.fn(),
    };
    const { container, rerender } = render(<Editor {...props} placeholder="Any thoughts?" />);

    expect(container.querySelector(".rich-editor p")).toHaveAttribute("data-placeholder", "Any thoughts?");

    rerender(<Editor {...props} placeholder="有什么想法？" />);

    expect(container.querySelector(".rich-editor p")).toHaveAttribute("data-placeholder", "有什么想法？");
  });
});

describe("rich editor round trips", () => {
  const mount = (content: string) => {
    const ref = createRef<EditorController>();
    const view = render(<Editor ref={ref} className="x" initialContent={content} placeholder="memo" onContentChange={vi.fn()} onFiles={vi.fn()} onSubmit={vi.fn()} />);
    return { ref, ...view };
  };

  it("keeps legacy HTML, math, footnotes and tables when saving", () => {
    const cases = [
      '<details><summary>概要</summary>原始内容</details>',
      '公式 $x^2 + y^2$ 保留',
      '引用[^1]\n\n[^1]: 注释内容',
      '| 列一 | 列二 |\n| --- | --- |\n| 内容一 | 内容二 |',
      '#### 四级标题',
    ];
    for (const content of cases) {
      const { ref, unmount } = mount(content);
      const saved = ref.current!.getMarkdown();
      if (content.startsWith('|')) {
        expect(saved).toContain('内容一');
        expect(saved).toContain('内容二');
        expect(document.querySelector('.rich-editor table')).not.toBeNull();
      } else if (content.startsWith('<details>')) {
        expect(saved).toContain('<summary>概要</summary>');
        expect(saved).toContain('原始内容');
        expect(document.querySelector('.rich-editor details summary')).toHaveTextContent('概要');
        expect(document.querySelector('.rich-editor [data-details-body]')).toHaveTextContent('原始内容');
      } else expect(saved.trim()).toBe(content);
      expect(saved).not.toContain('memos-preserved-content');
      unmount();
    }
  });

  it("renders files and references at their content position", () => {
    const { ref, container } = mount('前面\n\n![文档](</file/attachments/demo/test.pdf> "memos:file:application/pdf")\n\n![另一条笔记](</memos/target> "memos:reference")\n\n后面');
    const body = container.querySelector('.rich-editor')!;
    expect(body.textContent).toContain('前面📎 文档↗ 另一条笔记后面');
    expect(ref.current!.getMarkdown()).toContain('memos:file:application/pdf');
    expect(ref.current!.getMarkdown()).toContain('memos:reference');
    ref.current!.replaceFile!('/file/attachments/demo/test.pdf','');
    expect(ref.current!.getMarkdown()).not.toContain('test.pdf');
  });

  it("continues typing after an inserted file without replacing the file", () => {
    const { ref } = mount("before");
    ref.current!.insertFile!("/file/attachments/one/test.txt", "memos:file:text/plain", "test.txt");
    ref.current!.insertText!("after");
    expect(ref.current!.getMarkdown()).toContain("test.txt");
    expect(ref.current!.getMarkdown()).toContain("after");
  });

  it("preserves tasks and ordered lists and renders highlight without markers", () => {
    const { ref, container } = mount('1. 第一\n2. 第二\n\n- [ ] 吃饭\n- [x] 打扫\n\n==重点==');
    expect(container.querySelectorAll('.rich-editor ol li')).toHaveLength(2);
    expect(container.querySelectorAll('.rich-editor input[type="checkbox"]')).toHaveLength(2);
    expect(container.querySelector('.rich-editor mark')).toHaveTextContent('重点');
    expect(ref.current!.getMarkdown()).toContain('[x] 打扫');
  });
});

describe("keyboard and clipboard", () => {
  it("continues ordered lists with Shift+Enter and accepts pasted files", async () => {
    const { fireEvent, act } = await import('@testing-library/react');
    const ref = createRef<EditorController>();
    const onFiles = vi.fn();
    const { container } = render(<Editor ref={ref} className="x" initialContent="1. 示例" placeholder="" onContentChange={vi.fn()} onFiles={onFiles} onSubmit={vi.fn()} />);
    act(() => ref.current!.insertText!("一"));
    fireEvent.keyDown(container.querySelector('.rich-editor')!, { key: 'Enter', code: 'Enter', shiftKey: true });
    act(() => ref.current!.insertText!("二"));
    expect(container.querySelectorAll('.rich-editor ol li')).toHaveLength(2);
    const file = new File(['example'], 'example.txt', { type: 'text/plain' });
    fireEvent.paste(container.querySelector('.rich-editor')!, { clipboardData: { files: [file], getData: () => "", types: [] } });
    expect(onFiles).toHaveBeenCalledWith([file]);
  });
});


it("uses Enter to save only on desktop and ignores IME confirmation", async () => {
  const { fireEvent } = await import("@testing-library/react");
  preferences.enterToSave = true;
  const media = vi.fn();
  vi.stubGlobal("matchMedia", media);
  media.mockReturnValue({ matches: false } as MediaQueryList);
  const onSubmit = vi.fn();
  const { container } = render(<Editor className="x" initialContent="内容" placeholder="" onContentChange={vi.fn()} onFiles={vi.fn()} onSubmit={onSubmit} />);
  const body = container.querySelector(".rich-editor")!;
  fireEvent.keyDown(body, { key: "Enter", code: "Enter" });
  expect(onSubmit).toHaveBeenCalledTimes(1);
  media.mockReturnValue({ matches: true } as MediaQueryList);
  fireEvent.keyDown(body, { key: "Enter", code: "Enter" });
  expect(onSubmit).toHaveBeenCalledTimes(1);
  media.mockReturnValue({ matches: false } as MediaQueryList);
  fireEvent.compositionStart(body);
  fireEvent.keyDown(body, { key: "Enter", code: "Enter", isComposing: true });
  expect(onSubmit).toHaveBeenCalledTimes(1);
  preferences.enterToSave = false;
  vi.unstubAllGlobals();
});

it("focuses at the end of an existing task without adding a trailing paragraph", async () => {
  const { act } = await import("@testing-library/react");
  const ref = createRef<EditorController>();
  const { container } = render(<Editor ref={ref} className="x" initialContent="- [ ] 编辑待办" placeholder="" onContentChange={vi.fn()} onFiles={vi.fn()} onSubmit={vi.fn()} />);
  act(() => ref.current!.focus("end"));
  act(() => ref.current!.insertText!("末尾"));
  expect(ref.current!.getMarkdown().trim()).toBe("- [ ] 编辑待办末尾");
  expect(container.querySelector(".rich-editor > p")).toBeNull();
});

it("keeps currency editable while preserving actual math in the rich editor", async () => {
  const { waitFor } = await import("@testing-library/react");
  const ref = createRef<EditorController>();
  const props = { className: "x", placeholder: "", onContentChange: vi.fn(), onFiles: vi.fn(), onSubmit: vi.fn() };
  const { container, unmount } = render(<Editor {...props} ref={ref} initialContent="Price $20 and $30" />);
  expect(container.querySelector("[data-node-view-wrapper]")).toBeNull();
  expect(container.querySelector(".rich-editor p")).toHaveTextContent("Price $20 and $30");
  expect(ref.current!.getMarkdown()).toBe("Price $20 and $30");
  unmount();
  const formula = render(<Editor {...props} ref={ref} initialContent="Formula $x^2$" />);
  await waitFor(() => expect(formula.container.querySelector(".katex")).not.toBeNull());
  expect(ref.current!.getMarkdown().trim()).toBe("Formula $x^2$");
});
