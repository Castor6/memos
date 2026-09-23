import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTION_CHECK_TIMEOUT_MS, useMemosConnection } from "@/hooks/use-memos-connection";
import type { ConnectionStateResult } from "@/lib/messages";
import { oauthUserWithMemos, setMockOAuthUser } from "@/test/auth-mock";
import { browserMock } from "@/test/browser-mock";
import { act, renderHook, waitFor } from "@/test/render";

vi.mock("@/auth/auth-provider", () => import("@/test/auth-mock"));

const connection = (over: Partial<ConnectionStateResult> = {}): ConnectionStateResult => ({
  source: null,
  instanceUrl: null,
  version: null,
  displayName: null,
  status: "disconnected",
  verificationError: null,
  isUsingCachedVersion: false,
  ...over,
});

describe("useMemosConnection", () => {
  beforeEach(() => {
    setMockOAuthUser(null);
    browserMock.runtime.sendMessage.mockResolvedValue(connection());
  });

  afterEach(() => vi.useRealTimers());

  it("stops waiting for a silent worker and can retry without accepting the late response", async () => {
    vi.useFakeTimers();
    let finish!: (value: ConnectionStateResult) => void;
    browserMock.runtime.sendMessage.mockImplementationOnce(() => new Promise<ConnectionStateResult>((resolve) => (finish = resolve)));
    const { result } = renderHook(() => useMemosConnection());

    await act(async () => vi.advanceTimersByTimeAsync(CONNECTION_CHECK_TIMEOUT_MS));
    expect(result.current.isChecking).toBe(false);
    expect(result.current.status).toBe("error");
    expect(result.current.verificationError).toBe("extension-error");

    await act(async () => {
      await result.current.reverify();
    });
    expect(result.current.status).toBe("disconnected");
    await act(async () => finish(connection({ status: "ready", source: "direct" })));
    expect(result.current.status).toBe("disconnected");
    expect(result.current.source).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after a successful check", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useMemosConnection());
    await act(async () => {});
    expect(result.current.isChecking).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(CONNECTION_CHECK_TIMEOUT_MS));
    expect(result.current.status).toBe("disconnected");
  });

  it("reports a missing worker response as an extension error", async () => {
    browserMock.runtime.sendMessage.mockResolvedValue(undefined);
    const { result } = renderHook(() => useMemosConnection());
    await waitFor(() => expect(result.current.isChecking).toBe(false));
    expect(result.current.verificationError).toBe("extension-error");
  });

  it("reads sanitized connection state without exposing credentials", async () => {
    setMockOAuthUser(oauthUserWithMemos());
    browserMock.runtime.sendMessage.mockResolvedValue(
      connection({ instanceUrl: "https://memos.example.com", version: "0.29.1", status: "ready" }),
    );

    const { result } = renderHook(() => useMemosConnection());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.instanceUrl).toBe("https://memos.example.com");
    expect(result.current).not.toHaveProperty("credentials");
    expect(browserMock.runtime.sendMessage).toHaveBeenCalledWith({ type: "GET_CONNECTION_STATE", refresh: true, source: "active" });
  });

  it("is read-only and disconnected when the background has no Memos settings", async () => {
    setMockOAuthUser(oauthUserWithMemos());
    const { result } = renderHook(() => useMemosConnection());
    await waitFor(() => expect(result.current.isChecking).toBe(false));
    expect(result.current.status).toBe("disconnected");
    expect(result.current).not.toHaveProperty("connect");
    expect(result.current).not.toHaveProperty("disconnect");
  });

  it("reports malformed background-owned metadata as invalid", async () => {
    setMockOAuthUser(oauthUserWithMemos());
    browserMock.runtime.sendMessage.mockResolvedValue(connection({ status: "invalid" }));
    const { result } = renderHook(() => useMemosConnection());
    await waitFor(() => expect(result.current.status).toBe("invalid"));
    expect(result.current.instanceUrl).toBeNull();
  });

  it("keeps sanitized cached diagnostics while reporting a live timeout", async () => {
    setMockOAuthUser(oauthUserWithMemos());
    browserMock.runtime.sendMessage.mockResolvedValue(
      connection({
        instanceUrl: "https://memos.example.com",
        version: "0.29.1",
        status: "ready",
        verificationError: "timeout",
        isUsingCachedVersion: true,
      }),
    );
    const { result } = renderHook(() => useMemosConnection());
    await waitFor(() => expect(result.current.isChecking).toBe(false));
    expect(result.current.status).toBe("ready");
    expect(result.current.verificationError).toBe("timeout");
    expect(result.current.isUsingCachedVersion).toBe(true);
  });

  it("fails closed when the background cannot verify the account", async () => {
    setMockOAuthUser(oauthUserWithMemos());
    browserMock.runtime.sendMessage.mockRejectedValue(new Error("oauth unavailable"));
    const { result } = renderHook(() => useMemosConnection());
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.verificationError).toBe("auth-unavailable");
    expect(result.current.version).toBeNull();
  });
});
