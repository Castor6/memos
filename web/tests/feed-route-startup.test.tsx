import { act, render } from "@testing-library/react";
import { Suspense } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import FeedRoute from "@/router/FeedRoute";
import { LandingRoute, RequireAuthRoute } from "@/router/guards";

const state = vi.hoisted(() => ({
  user: undefined as { name: string } | undefined,
  load: vi.fn(),
  resolve: undefined as ((page: { default: () => React.ReactNode }) => void) | undefined,
}));
vi.mock("@/hooks/useCurrentUser", () => ({ default: () => state.user }));
vi.mock("@/utils/i18n", () => ({ useTranslate: () => (key: string) => key }));
vi.mock("@/router/home-page", () => ({
  loadHomePage: () => {
    state.load();
    return new Promise((resolve) => {
      state.resolve = resolve;
    });
  },
}));

function mount(path: string) {
  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <nav>Navigation</nav>
            <aside>Sidebar</aside>
            <Outlet />
          </>
        ),
        children: [
          { element: <LandingRoute />, children: [{ index: true, element: <FeedRoute /> }] },
          { element: <RequireAuthRoute />, children: [{ path: "todos", element: <FeedRoute isTodo /> }] },
        ],
      },
      { path: "auth", element: <p>Sign in</p> },
      { path: "explore", element: <p>Public feed</p> },
    ],
    { initialEntries: [path] },
  );
  return render(
    <Suspense fallback={null}>
      <RouterProvider router={router} />
    </Suspense>,
  );
}

describe("feed route startup boundary", () => {
  it.each([
    ["/", "Public feed"],
    ["/todos", "Sign in"],
  ])("does not import or hand over a guarded feed for anonymous %s", async (path, destination) => {
    const shell = vi.fn();
    window.addEventListener("memos:startup-shell-ready", shell);
    const view = mount(path);
    expect(await view.findByText(destination)).toBeInTheDocument();
    expect(state.load).not.toHaveBeenCalled();
    expect(shell).not.toHaveBeenCalled();
    window.removeEventListener("memos:startup-shell-ready", shell);
  });

  it("commits the verified route shell while Home is suspended without announcing a successful page", async () => {
    vi.useFakeTimers();
    state.user = { name: "users/test" };
    const shell = vi.fn();
    const ready = vi.fn();
    window.addEventListener("memos:startup-shell-ready", shell);
    window.addEventListener("memos:startup-ready", ready);
    const view = mount("/todos");
    expect(view.getByText("Navigation")).toBeInTheDocument();
    expect(view.getByText("Sidebar")).toBeInTheDocument();
    expect(view.container.querySelector("[data-feed-placeholder]")).not.toBeNull();
    expect(shell).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
    expect(view.queryByRole("button", { name: "memo.retry" })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(12000));
    expect(view.getByRole("button", { name: "memo.retry" })).toBeInTheDocument();
    expect(view.getByText("Navigation")).toBeInTheDocument();
    await act(async () => {
      state.resolve!({ default: () => <p>Loaded feed</p> });
    });
    expect(view.getByText("Loaded feed")).toBeInTheDocument();
    expect(view.container.querySelector("[data-feed-placeholder]")).toBeNull();
    expect(shell).toHaveBeenCalledOnce();
    expect(view.queryByRole("button", { name: "memo.retry" })).not.toBeInTheDocument();
    window.removeEventListener("memos:startup-shell-ready", shell);
    window.removeEventListener("memos:startup-ready", ready);
    vi.useRealTimers();
  });
});
