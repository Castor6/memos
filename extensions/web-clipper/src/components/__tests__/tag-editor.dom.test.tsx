import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TagEditor } from "@/components/tag-editor";

async function openEditor(props: Partial<Parameters<typeof TagEditor>[0]> = {}) {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<TagEditor tags={["Star"]} suggestions={[]} onChange={onChange} {...props} />);
  await user.click(screen.getByRole("button", { name: "＋ 添加标签" }));
  return { user, onChange, input: screen.getByRole("combobox") };
}

describe("TagEditor", () => {
  it("removes a selected chip", async () => {
    const { user, onChange } = await openEditor({ tags: ["Star", "读书"] });
    await user.click(screen.getByRole("button", { name: "移除标签 读书" }));
    expect(onChange).toHaveBeenCalledWith(["Star"]);
  });

  it("filters and deduplicates existing tags and navigates by keyboard", async () => {
    const { user, onChange, input } = await openEditor({ suggestions: ["Star", "阅读", "阅读", "阅读/科技", "其他"] });
    expect(input).toHaveFocus();
    await user.type(input, "阅读");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith(["Star", "阅读/科技"]);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "＋ 添加标签" })).toHaveFocus();
  });

  it("creates trimmed labels with spaces and prevents exact duplicates", async () => {
    const { user, onChange, input } = await openEditor();
    await user.type(input, "Star");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "  Pick up  ");
    await user.click(screen.getByRole("option", { name: "新建“Pick up”" }));
    expect(onChange).toHaveBeenCalledWith(["Star", "Pick up"]);
  });

  it("does not submit an IME composition or legacy composition key", async () => {
    const { input, onChange } = await openEditor();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "中文" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["Star", "中文"]);
  });

  it("closes with Escape and supports wrapping upwards", async () => {
    const { user, onChange } = await openEditor({ suggestions: ["甲", "乙"] });
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("option", { name: "乙" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("allows creating labels after suggestion loading fails and offers retry", async () => {
    const onRetry = vi.fn();
    const { user, input, onChange } = await openEditor({ error: "无法加载已有标签", onRetry });
    await user.click(screen.getByRole("button", { name: "重试加载标签" }));
    expect(onRetry).toHaveBeenCalledOnce();
    await user.type(input, "新标签{Enter}");
    expect(onChange).toHaveBeenCalledWith(["Star", "新标签"]);
  });

  it("enforces UTF-8 byte limits and forbidden control characters", async () => {
    const { input, onChange } = await openEditor();
    for (const value of ["文".repeat(86), "invalid\u001ftag", "invalid\u0000tag"]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByRole("alert")).toHaveTextContent("256 字节");
    }
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: `${"文".repeat(85)}a` } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["Star", `${"文".repeat(85)}a`]);
  });

  it("prevents additions beyond 100 tags while retaining removal", async () => {
    const tags = Array.from({ length: 100 }, (_, index) => `tag-${index}`);
    const { user, input, onChange } = await openEditor({ tags });
    await user.type(input, "extra{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("100");
    await user.click(screen.getByRole("button", { name: "移除标签 tag-0" }));
    expect(onChange).toHaveBeenCalledWith(tags.slice(1));
  });

  it("disables all mutations when disabled", () => {
    render(<TagEditor tags={["Star"]} suggestions={[]} onChange={vi.fn()} disabled />);
    expect(screen.getByRole("button", { name: "移除标签 Star" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "＋ 添加标签" })).toBeDisabled();
  });
});
