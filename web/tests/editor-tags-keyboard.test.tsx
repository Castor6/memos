import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import EditorTags from "@/components/MemoEditor/components/EditorTags";
import Editor from "@/components/MemoEditor/Editor";
import { EditorProvider } from "@/components/MemoEditor/state";
import type { EditorController } from "@/components/MemoEditor/types/editorController";

vi.mock("@/contexts/MemoFilterContext", () => ({ useMemoFilterContext: () => ({ filters: [] }) }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({}) }));
vi.mock("@/hooks/useUserQueries", () => ({ useTagCounts: () => ({ data: { "工作/开发": 2, "工作/记录": 1, 生活: 1 } }) }));

const open = async () => {
  render(
    <EditorProvider>
      <EditorTags editing />
    </EditorProvider>,
  );
  fireEvent.click(screen.getByText("＋ 添加标签"));
  return screen.findByRole("combobox");
};

describe("editor tag keyboard selection", () => {
  it("selects a highlighted existing tag instead of creating the partial query", async () => {
    const input = await open();
    fireEvent.change(input, { target: { value: "工作" } });
    expect(screen.getByRole("option", { name: "工作/开发" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "工作/记录" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "移除标签 工作/记录" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "移除标签 工作" })).toBeNull();
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  });

  it("supports explicit creation with arrow-up and leaves IME confirmation alone", async () => {
    const input = await open();
    fireEvent.change(input, { target: { value: "工作" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByRole("option", { name: "新建“工作”" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(screen.queryByRole("button", { name: "移除标签 工作" })).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "移除标签 工作" })).toBeInTheDocument();
  });

  it("resets selection after filtering and closes without adding on Escape", async () => {
    const input = await open();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.change(input, { target: { value: "生活" } });
    expect(screen.getByRole("option", { name: "生活" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
    expect(screen.queryByRole("button", { name: "移除标签 生活" })).toBeNull();
  });
});

it("focuses the tag search without scrolling the document", async () => {
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  const input = await open();
  await waitFor(() => expect(input).toHaveFocus());
  expect(focus.mock.calls.some(([options]) => options?.preventScroll === true)).toBe(true);
  focus.mockRestore();
});

it.each(["", "- [ ] "])("moves from the tag trigger into the editable body for %j", async (content) => {
  const ref = createRef<EditorController>();
  render(
    <EditorProvider>
      <EditorTags editing={false} onFocusContent={() => ref.current?.focus()} />
      <Editor ref={ref} className="test" initialContent={content} placeholder="" onContentChange={vi.fn()} onFiles={vi.fn()} onSubmit={vi.fn()} />
    </EditorProvider>,
  );
  const trigger = screen.getByRole("button", { name: "＋ 添加标签" });
  fireEvent.click(trigger);
  const input = await screen.findByRole("combobox");
  fireEvent.change(input, { target: { value: "生活" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
  fireEvent.keyDown(trigger, { key: "Tab" });
  await waitFor(() => expect(screen.getByRole("textbox", { name: "正文" })).toHaveFocus());
  ref.current?.insertText?.("继续填写");
  expect(ref.current?.getMarkdown()).toContain(content ? "- [ ] 继续填写" : "继续填写");
});

it("does not intercept backward Tab navigation", () => {
  const focus = vi.fn();
  render(<EditorProvider><EditorTags editing onFocusContent={focus} /></EditorProvider>);
  fireEvent.keyDown(screen.getByRole("button", { name: "＋ 添加标签" }), { key: "Tab", shiftKey: true });
  expect(focus).not.toHaveBeenCalled();
});
