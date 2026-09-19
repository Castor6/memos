import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyThemeEarly, getThemeWithFallback, loadTheme } from "@/utils/theme";

describe("built-in theme lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
    document.head.insertAdjacentHTML("beforeend", '<meta name="theme-color" content="">');
  });

  afterEach(() => {
    loadTheme("default");
    localStorage.clear();
    document.querySelector('meta[name="theme-color"]')?.remove();
  });

  it.each([
    ["cream", "#fcf9f5"],
    ["mint", "#f1f8f3"],
    ["flomo", "#f8f8f8"],
  ])("restores %s on startup and removes its styles on theme switch", (theme, color) => {
    loadTheme(theme);
    expect(getThemeWithFallback(theme)).toBe(theme);
    expect(localStorage.getItem("memos-theme")).toBe(theme);
    document.getElementById("instance-theme")?.remove();
    document.documentElement.removeAttribute("data-theme");
    applyThemeEarly();
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(color);
    expect(document.getElementById("instance-theme")?.textContent).toContain(color);
    loadTheme("default-dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.querySelectorAll("#instance-theme")).toHaveLength(1);
    expect(document.getElementById("instance-theme")?.textContent).not.toContain("--theme-tag-bg");
    loadTheme("default");
    expect(document.getElementById("instance-theme")).toBeNull();
  });
});
