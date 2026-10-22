import { beforeEach, describe, expect, it, vi } from "vitest";

describe("initial Home module preload", () => {
  beforeEach(() => vi.resetModules());

  it("preloads only feed routes, shares the pending import, and does not mount the page", async () => {
    const mount = vi.fn();
    const imported = vi.fn(() => ({ default: mount }));
    vi.doMock("@/pages/Home", imported);
    const { getLoadedHomePage, loadHomePage, preloadInitialHomePage } = await import("@/router/home-page");
    preloadInitialHomePage("/auth");
    preloadInitialHomePage("/memos/share");
    expect(imported).not.toHaveBeenCalled();
    for (const path of ["/", "/todos", "/todos/", "/home"]) preloadInitialHomePage(path);
    const first = loadHomePage();
    expect(loadHomePage()).toBe(first);
    expect(getLoadedHomePage()).toBeUndefined();
    await first;
    expect(imported).toHaveBeenCalledOnce();
    expect(getLoadedHomePage()?.default).toBe(mount);
    expect(mount).not.toHaveBeenCalled();
  });

  it("absorbs a speculative failure but preserves it for actual lazy-render recovery", async () => {
    const error = new Error("Controlled import failure");
    vi.doMock("@/pages/Home", () => {
      throw error;
    });
    const { getLoadedHomePage, loadHomePage, preloadInitialHomePage } = await import("@/router/home-page");
    expect(() => preloadInitialHomePage("/")).not.toThrow();
    await expect(loadHomePage()).rejects.toThrow();
    expect(loadHomePage()).toBe(loadHomePage());
    expect(getLoadedHomePage()).toBeUndefined();
  });
});
