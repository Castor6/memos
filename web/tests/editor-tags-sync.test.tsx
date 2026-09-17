import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import EditorTags from "@/components/MemoEditor/components/EditorTags";
import { EditorProvider, useEditorContext, useEditorSelector } from "@/components/MemoEditor/state";

const filters = vi.hoisted(() => ({ current: [] as { factor: string; value: string }[] }));
vi.mock("@/contexts/MemoFilterContext", () => ({ useMemoFilterContext: () => ({ filters: filters.current }) }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({}) }));
vi.mock("@/hooks/useUserQueries", () => ({ useTagCounts: () => ({ data: {} }) }));

function Content({ editing = false }: { editing?: boolean }) {
  const { actions, dispatch } = useEditorContext();
  const tags = useEditorSelector((state) => state.metadata.tags);
  return <><button onClick={() => dispatch(actions.setMetadata({ tags: [...(tags ?? []), "手动"] }))}>手动添加</button><EditorTags editing={editing} /></>;
}
const ui = (editing = false) => <EditorProvider><Content editing={editing} /></EditorProvider>;

describe("filter-derived editor tags", () => {
  it("withdraws only automatic tags when changing or clearing a filter", () => {
    filters.current = [{ factor: "tagSearch", value: "工作" }];
    const { rerender } = render(ui());
    expect(screen.getByRole("button", { name: "移除标签 工作" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("手动添加"));
    filters.current = [{ factor: "tagSearch", value: "生活" }];
    rerender(ui());
    expect(screen.queryByRole("button", { name: "移除标签 工作" })).toBeNull();
    expect(screen.getByRole("button", { name: "移除标签 生活" })).toBeInTheDocument();
    filters.current = [];
    rerender(ui());
    expect(screen.queryByRole("button", { name: "移除标签 生活" })).toBeNull();
    expect(screen.getByRole("button", { name: "移除标签 手动" })).toBeInTheDocument();
  });
  it("keeps a pre-existing manual tag and leaves existing memo tags alone", () => {
    filters.current = [];
    const { rerender } = render(ui());
    fireEvent.click(screen.getByText("手动添加"));
    filters.current = [{ factor: "tagSearch", value: "手动" }];
    rerender(ui());
    filters.current = [];
    rerender(ui());
    expect(screen.getByRole("button", { name: "移除标签 手动" })).toBeInTheDocument();
    filters.current = [{ factor: "tagSearch", value: "无关筛选" }];
    rerender(ui(true));
    expect(screen.queryByRole("button", { name: "移除标签 无关筛选" })).toBeNull();
  });
});
