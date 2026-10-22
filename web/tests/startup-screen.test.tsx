import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render } from "@testing-library/react";
import { JSDOM } from "jsdom";
import { lazy, Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import StartupReady from "@/components/StartupReady";
import { deferStartupStyles } from "../plugins/startup-html";

const readiness = vi.hoisted(() => ({ identity: true, profile: true, auth: true, instance: true }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ isIdentityInitialized: readiness.identity, isInitialized: readiness.auth }),
}));
vi.mock("@/contexts/InstanceContext", () => ({
  useInstance: () => ({ isProfileInitialized: readiness.profile, isInitialized: readiness.instance }),
}));

const source = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const windows: JSDOM[] = [];

function boot({ css = false, dark = false, blockedStorage = false } = {}) {
  const html = css ? deferStartupStyles(source.replace("</head>", '<link rel="stylesheet" href="/assets/app.css"></head>')) : source;
  const dom = new JSDOM(html, { url: "https://memos.test", runScripts: "outside-only" });
  windows.push(dom);
  const { window } = dom;
  window.matchMedia = (() => ({ matches: dark })) as typeof window.matchMedia;
  window.localStorage.setItem("memos-locale", "zh-Hans");
  if (blockedStorage)
    Object.defineProperty(window, "localStorage", {
      get: () => {
        throw new Error("Blocked");
      },
    });
  window.eval(window.document.getElementById("startup-appearance")!.textContent!);
  window.eval(window.document.getElementById("startup-script")!.textContent!);
  return {
    window,
    document: window.document,
    ready: () => window.dispatchEvent(new window.Event("memos:startup-ready")),
    cssLoaded: () => window.document.querySelector("link[data-startup-stylesheet]")!.dispatchEvent(new window.Event("load")),
  };
}

afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
  vi.useRealTimers();
});

describe("static startup screen", () => {
  it("keeps the screen until a real page is ready, then unlocks the root without a minimum delay", () => {
    const { document, ready } = boot();
    expect(document.getElementById("startup-screen")).not.toBeNull();
    expect(document.getElementById("root")!.hasAttribute("inert")).toBe(true);
    ready();
    expect(document.getElementById("startup-screen")).toBeNull();
    expect(document.getElementById("root")!.hasAttribute("inert")).toBe(false);
    expect(document.getElementById("root")!.hasAttribute("aria-hidden")).toBe(false);
  });

  it("does not reveal an unstyled page when its module finishes before the stylesheet", () => {
    const { document, ready, cssLoaded } = boot({ css: true });
    ready();
    expect(document.getElementById("startup-screen")).not.toBeNull();
    const link = document.querySelector<HTMLLinkElement>("link[data-startup-stylesheet]")!;
    expect(link.rel).toBe("stylesheet");
    expect(link.media).toBe("print");
    cssLoaded();
    expect(link.media).toBe("all");
    expect(document.getElementById("startup-screen")).toBeNull();
  });

  it("keeps the startup screen when styles finish before the route", () => {
    const { document, ready, cssLoaded } = boot({ css: true });
    cssLoaded();
    expect(document.getElementById("startup-screen")).not.toBeNull();
    ready();
    expect(document.getElementById("startup-screen")).toBeNull();
  });

  it("offers recovery and retains the screen if the application stylesheet fails", () => {
    const { window, document, ready } = boot({ css: true });
    document.querySelector("link[data-startup-stylesheet]")!.dispatchEvent(new window.Event("error"));
    ready();
    expect(document.getElementById("startup-screen")).not.toBeNull();
    expect(document.getElementById("startup-recovery")!.hidden).toBe(false);
    expect(document.getElementById("root")!.hasAttribute("inert")).toBe(true);
  });

  it("shows retry feedback if JavaScript or initialization is still pending after twelve seconds", () => {
    vi.useFakeTimers();
    const { document } = boot();
    expect(document.getElementById("startup-recovery")!.hidden).toBe(true);
    vi.advanceTimersByTime(12000);
    expect(document.getElementById("startup-recovery")!.hidden).toBe(false);
    expect(document.getElementById("startup-status")!.textContent).toContain("检查网络");
  });

  it("can start with blocked storage and follows the system dark appearance", () => {
    const { document } = boot({ blockedStorage: true, dark: true });
    expect(document.documentElement.dataset.theme).toBe("default-dark");
    expect(document.getElementById("startup-status")!.textContent).toBe("Opening Memos…");
  });

  it("preloads entry CSS without blocking first paint and preserves a noscript stylesheet", () => {
    const html = deferStartupStyles(
      '<link rel="stylesheet" crossorigin href="/assets/app.css"><script type="module" src="/assets/app.js"></script>',
    );
    const document = new JSDOM(html).window.document;
    const link = document.querySelector<HTMLLinkElement>("link[data-startup-stylesheet]")!;
    expect(link.rel).toBe("preload");
    expect(link.getAttribute("as")).toBe("style");
    expect(link.getAttribute("href")).toBe("/assets/app.css");
    expect(document.querySelector("noscript")!.innerHTML).toContain('rel="stylesheet"');
    expect(document.querySelector("script")!.getAttribute("src")).toBe("/assets/app.js");
  });
});

describe("React startup handoff", () => {
  beforeEach(() => {
    readiness.identity = true;
    readiness.profile = true;
    readiness.auth = true;
    readiness.instance = true;
  });

  it("hands over the feed shell after identity and profile settle without waiting for settings", () => {
    const notify = vi.fn();
    window.addEventListener("memos:startup-ready", notify);
    readiness.identity = false;
    readiness.profile = false;
    readiness.auth = false;
    readiness.instance = false;
    const content = () => (
      <StartupReady waitForSettings={false}>
        <main>Feed shell</main>
      </StartupReady>
    );
    const view = render(content());
    expect(notify).not.toHaveBeenCalled();
    readiness.identity = true;
    view.rerender(content());
    expect(notify).not.toHaveBeenCalled();
    readiness.profile = true;
    view.rerender(content());
    expect(view.getByText("Feed shell")).toBeInTheDocument();
    expect(notify).toHaveBeenCalledOnce();
    readiness.auth = true;
    readiness.instance = true;
    view.rerender(content());
    expect(notify).toHaveBeenCalledOnce();
    window.removeEventListener("memos:startup-ready", notify);
  });

  it("waits for both display-sensitive settings without blocking the page from starting requests", () => {
    const notify = vi.fn();
    window.addEventListener("memos:startup-ready", notify);
    readiness.auth = false;
    readiness.instance = false;
    const view = render(
      <StartupReady>
        <main>Page shell</main>
      </StartupReady>,
    );
    expect(view.getByText("Page shell")).toBeInTheDocument();
    expect(notify).not.toHaveBeenCalled();
    readiness.auth = true;
    view.rerender(
      <StartupReady>
        <main>Page shell</main>
      </StartupReady>,
    );
    expect(notify).not.toHaveBeenCalled();
    readiness.instance = true;
    view.rerender(
      <StartupReady>
        <main>Page shell</main>
      </StartupReady>,
    );
    expect(notify).toHaveBeenCalledOnce();
    window.removeEventListener("memos:startup-ready", notify);
  });

  it.each([true, false])("does not finish while the first lazy page is suspended (waitForSettings=%s)", async (waitForSettings) => {
    const notify = vi.fn();
    window.addEventListener("memos:startup-ready", notify);
    let resolve!: (value: { default: () => React.ReactNode }) => void;
    const Page = lazy(
      () =>
        new Promise<{ default: () => React.ReactNode }>((done) => {
          resolve = done;
        }),
    );
    render(
      <Suspense fallback={null}>
        <StartupReady waitForSettings={waitForSettings}>
          <Page />
        </StartupReady>
      </Suspense>,
    );
    expect(notify).not.toHaveBeenCalled();
    await act(async () => {
      resolve({ default: () => <main>Ready page</main> });
    });
    expect(notify).toHaveBeenCalledOnce();
    window.removeEventListener("memos:startup-ready", notify);
  });

  it("hands over to the error page if rendering fails before initialization completes", () => {
    const notify = vi.fn();
    window.addEventListener("memos:startup-ready", notify);
    vi.spyOn(console, "error").mockImplementation(() => {});
    readiness.auth = false;
    const BrokenPage = () => {
      throw new Error("Startup failed");
    };
    const view = render(
      <ErrorBoundary>
        <BrokenPage />
      </ErrorBoundary>,
    );
    expect(view.getByText("Something went wrong")).toBeInTheDocument();
    expect(notify).toHaveBeenCalledOnce();
    expect((notify.mock.calls[0][0] as CustomEvent).detail).toEqual({ success: false });
    window.removeEventListener("memos:startup-ready", notify);
  });
});
