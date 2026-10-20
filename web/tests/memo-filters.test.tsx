import { act, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MemoFilterProvider, stringifyFilters, useMemoFilterContext } from "@/contexts/MemoFilterContext";
import { useMemoFilters } from "@/hooks/useMemoFilters";

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ shortcuts: [{ name: "users/test/shortcuts/1", filter: 'has_link || has_code', isTodo: false }] }),
}));

let context: ReturnType<typeof useMemoFilterContext>;
function Probe() {
  context = useMemoFilterContext();
  const filter = useMemoFilters({ creatorName: "users/test", includeShortcuts: true });
  return <output data-testid="query">{filter}</output>;
}

function setup(search = "") {
  const router = createMemoryRouter(
    [{ path: "*", element: <MemoFilterProvider><Probe /></MemoFilterProvider> }],
    { initialEntries: [`/${search}`] },
  );
  const view = render(<RouterProvider router={router} />);
  return { router, ...view };
}

describe("memo tag and property filters", () => {
  it("accumulates same-event filters, defaults to union and combines other dimensions with AND", () => {
    const { router } = setup("?unrelated=keep");
    act(() => {
      context.addFilter({ factor: "tagSearch", value: "工作" });
      context.addFilter({ factor: "tagSearch", value: '项目"A' });
      context.addFilter({ factor: "tagSearch", value: "工作" });
      context.addFilter({ factor: "property.hasIncompleteTasks", value: "true" });
      context.addFilter({ factor: "mcpHidden", value: "true" });
      context.addFilter({ factor: "contentSearch", value: "hello" });
    });
    expect(context.filters).toHaveLength(5);
    expect(context.tagMatchMode).toBe("any");
    expect(screen.getByTestId("query").textContent).toBe(
      'creator == "users/test" && tag in ["工作", "项目\\"A"] && has_incomplete_tasks && mcp_hidden && content.contains("hello")',
    );
    expect(new URLSearchParams(router.state.location.search).get("unrelated")).toBe("keep");
    act(() => context.setShortcut("1"));
    expect(screen.getByTestId("query").textContent).toContain('(has_link || has_code) && tag in');
    expect(context.filters.some((filter) => filter.factor === "contentSearch")).toBe(false);
  });

  it("persists intersection, resets it only after the last tag or all filters are removed", () => {
    const { router } = setup();
    act(() => {
      context.addFilter({ factor: "tagSearch", value: "工作" });
      context.addFilter({ factor: "tagSearch", value: "项目" });
      context.setTagMatchMode("all");
    });
    expect(screen.getByTestId("query").textContent).toContain('tag in ["工作"] && tag in ["项目"]');
    expect(new URLSearchParams(router.state.location.search).get("tagMode")).toBe("all");
    act(() => context.removeFilter((filter) => filter.value === "工作"));
    expect(context.tagMatchMode).toBe("all");
    act(() => context.removeFiltersByFactor("tagSearch"));
    expect(context.tagMatchMode).toBe("any");
    expect(new URLSearchParams(router.state.location.search).has("tagMode")).toBe(false);
    act(() => {
      context.addFilter({ factor: "tagSearch", value: "生活" });
      context.setTagMatchMode("all");
      context.clearAllFilters();
    });
    expect(context.filters).toEqual([]);
    expect(context.tagMatchMode).toBe("any");
  });

  it("restores URL filters on refresh and back/forward without writing stale state", async () => {
    const search = new URLSearchParams({
      filter: stringifyFilters([{ factor: "tagSearch", value: "工作,项目:计划" }, { factor: "tagSearch", value: "生活" }]),
      tagMode: "all",
    }).toString();
    const { router, unmount } = setup(`?${search}`);
    expect(context.tagMatchMode).toBe("all");
    expect(context.filters.map((filter) => filter.value)).toEqual(["工作,项目:计划", "生活"]);
    await act(async () => { await router.navigate("/todos?filter=mcpHidden:true"); });
    expect(context.filters).toEqual([{ factor: "mcpHidden", value: "true" }]);
    expect(context.tagMatchMode).toBe("any");
    await act(async () => { await router.navigate(-1); });
    expect(context.tagMatchMode).toBe("all");
    expect(context.filters).toHaveLength(2);
    await act(async () => { await router.navigate(1); });
    expect(context.filters).toEqual([{ factor: "mcpHidden", value: "true" }]);
    unmount();
    setup(`?${search}`);
    expect(context.tagMatchMode).toBe("all");
    expect(context.filters).toHaveLength(2);
  });
});
