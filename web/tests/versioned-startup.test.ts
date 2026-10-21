import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferStartupStyles, stampStartupBuild } from "../plugins/startup-html";

const source = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const html = stampStartupBuild(
  deferStartupStyles(source.replace("</head>", '<link rel="stylesheet" href="/assets/app.css"></head>')),
  "1.0.0",
);
const buildId = html.match(/name="memos-build-id" content="([a-f0-9]+)"/)![1];
const key = "memos-successful-build";
const windows: JSDOM[] = [];
function boot({ previous = "", path = "/", blocked = false, dark = false } = {}) {
  const dom = new JSDOM(html, { url: `https://memos.test${path}`, runScripts: "outside-only" });
  windows.push(dom);
  const { window } = dom;
  const document = window.document;
  window.matchMedia = (() => ({ matches: dark })) as typeof window.matchMedia;
  if (previous) window.localStorage.setItem(key, previous);
  if (blocked)
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("Blocked");
      },
    });
  window.eval(document.getElementById("startup-appearance")!.textContent!);
  window.eval(document.getElementById("startup-script")!.textContent!);
  return {
    window,
    document,
    mode: document.documentElement.dataset.startupMode,
    ready: (success = true) => window.dispatchEvent(new window.CustomEvent("memos:startup-ready", { detail: { success } })),
    shell: () => window.dispatchEvent(new window.Event("memos:startup-shell-ready")),
    css: (type = "load") => document.querySelector("link[data-startup-stylesheet]")!.dispatchEvent(new window.Event(type)),
    visible: () => !!document.getElementById("startup-screen"),
  };
}
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
  vi.useRealTimers();
});

describe("version-aware document startup", () => {
  it("stamps a deterministic ID including version, document, and asset URLs", () => {
    expect(stampStartupBuild(source, "1.0.0")).toBe(stampStartupBuild(source, "1.0.0"));
    expect(stampStartupBuild(source, "1.0.0")).not.toBe(stampStartupBuild(source, "1.0.1"));
    expect(stampStartupBuild(source, "1.0.0")).not.toBe(stampStartupBuild(`${source} `, "1.0.0"));
    expect(stampStartupBuild(source.replace("/src/main.tsx", "/assets/changed.js"), "1.0.0")).not.toBe(stampStartupBuild(source, "1.0.0"));
    expect(html).not.toContain("__MEMOS_BUILD_ID__");
  });
  it.each(["/", "/home", "/home/", "/todos", "/todos/"])("uses the inert shell on a successful same-build feed %s", (path) => {
    const app = boot({ previous: buildId, path });
    expect(app.mode).toBe("warm");
    const shell = app.document.querySelector(".startup-shell")!;
    expect(shell.hasAttribute("inert")).toBe(true);
    expect(shell.textContent!.trim()).toBe("");
    expect(shell.querySelector("button,a,input,img")).toBeNull();
  });
  it.each(["/auth", "/memos/123", "/settings", "/home/extra"])("keeps B on non-feed %s", (path) => {
    expect(boot({ previous: buildId, path }).mode).toBe("cold");
  });
  it("keeps B for first launch, changed builds, and blocked storage, with the system theme", () => {
    expect(boot().mode).toBe("cold");
    expect(boot({ previous: "a".repeat(64) }).mode).toBe("cold");
    const app = boot({ blocked: true, dark: true });
    expect(app.mode).toBe("cold");
    expect(app.document.documentElement.dataset.theme).toBe("default-dark");
    app.css();
    app.ready();
    expect(app.visible()).toBe(false);
  });
  it("ignores shell readiness on a new build and records success only after CSS", () => {
    const app = boot();
    app.shell();
    app.ready();
    expect(app.visible()).toBe(true);
    expect(app.window.localStorage.getItem(key)).toBeNull();
    app.css();
    expect(app.visible()).toBe(false);
    expect(app.window.localStorage.getItem(key)).toBe(buildId);
  });
  it("hands a warm launch to the real shell after CSS but waits for terminal success to write", () => {
    const app = boot({ previous: buildId });
    const write = vi.spyOn(app.window.Storage.prototype, "setItem");
    app.shell();
    expect(app.visible()).toBe(true);
    app.css();
    expect(app.visible()).toBe(false);
    expect(write).not.toHaveBeenCalled();
    app.ready();
    expect(write).toHaveBeenCalledExactlyOnceWith(key, buildId);
  });
  it.each([false, true])("does not mark terminal failures successful (warm=%s)", (warm) => {
    const app = boot({ previous: warm ? buildId : "" });
    const write = vi.spyOn(app.window.Storage.prototype, "setItem");
    app.css();
    app.shell();
    app.ready(false);
    expect(app.visible()).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
  it("does not mark an earlier success if failure arrives while CSS is pending", () => {
    const app = boot();
    app.ready();
    app.ready(false);
    app.css();
    expect(app.visible()).toBe(false);
    expect(app.window.localStorage.getItem(key)).toBeNull();
  });
  it("preserves recovery and never records success when CSS fails", () => {
    const app = boot({ previous: buildId });
    const write = vi.spyOn(app.window.Storage.prototype, "setItem");
    app.shell();
    app.ready();
    app.css("error");
    expect(app.visible()).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(app.document.getElementById("startup-recovery")!.hidden).toBe(false);
  });
  it("offers recovery on a stalled warm launch", () => {
    vi.useFakeTimers();
    const app = boot({ previous: buildId });
    vi.advanceTimersByTime(12000);
    expect(app.document.getElementById("startup-recovery")!.hidden).toBe(false);
  });
  it("does not overwrite a successful newer build completed in another window", () => {
    const app = boot();
    const newer = "b".repeat(64);
    app.window.localStorage.setItem(key, newer);
    app.css();
    app.ready();
    expect(app.window.localStorage.getItem(key)).toBe(newer);
    expect(app.visible()).toBe(false);
  });
  it("still reveals a successful page when the marker cannot be written", () => {
    const app = boot();
    vi.spyOn(app.window.Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Full");
    });
    app.css();
    app.ready();
    expect(app.visible()).toBe(false);
  });
});
