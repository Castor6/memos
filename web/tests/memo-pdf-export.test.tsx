import { create } from "@bufbuild/protobuf";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMemoPdfExport } from "@/components/MemoActionMenu/useMemoPdfExport";
import { MemoSchema } from "@/types/proto/api/v1/memo_service_pb";

const mocks = vi.hoisted(() => ({
  export: vi.fn(),
  shared: vi.fn(),
  toast: { loading: vi.fn(() => "export"), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("@/connect", () => ({ memoServiceClient: { exportMemoPdf: mocks.export, exportSharedMemoPdf: mocks.shared } }));
vi.mock("react-hot-toast", () => ({ default: mocks.toast }));
const memo = create(MemoSchema, { name: "memos/test", property: { title: "中文笔记" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:pdf"), revokeObjectURL: vi.fn() });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("server PDF download", () => {
  it("waits for the server, rejects repeat clicks, then downloads without a dialog", async () => {
    let resolve!: (value: { content: Uint8Array }) => void;
    mocks.export.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    let downloaded = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
      expect(this.href).toBe("blob:pdf");
    });
    const { result } = renderHook(() => useMemoPdfExport(memo));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.download();
      void result.current.download();
    });
    expect(result.current.exporting).toBe(true);
    expect(mocks.export).toHaveBeenCalledOnce();
    expect(downloaded).toBe("");
    await act(async () => {
      resolve({ content: new TextEncoder().encode("%PDF-1.7") });
      await pending;
    });
    expect(result.current.exporting).toBe(false);
    expect(downloaded).toBe("中文笔记.pdf");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: "application/pdf" }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:pdf");
  });

  it("shows the server error and lets the user retry", async () => {
    mocks.export.mockRejectedValueOnce(new Error("图片读取失败")).mockResolvedValueOnce({ content: new Uint8Array() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { result } = renderHook(() => useMemoPdfExport(memo));
    await act(async () => result.current.download());
    expect(click).not.toHaveBeenCalled();
    expect(result.current.exporting).toBe(false);
    render(mocks.toast.error.mock.calls[0][0]({ id: "export" }));
    expect(screen.getByText("图片读取失败")).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重试" })));
    expect(mocks.export).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledOnce();
  });
});

it("uses the share-specific endpoint on a share page", async () => {
  mocks.shared.mockResolvedValue({ content: new Uint8Array() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  function Export() {
    const { download } = useMemoPdfExport(memo);
    return <button onClick={() => void download()}>导出</button>;
  }
  render(
    <MemoryRouter initialEntries={["/memos/shares/local-test-token"]}>
      <Routes>
        <Route path="/memos/shares/:token" element={<Export />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "导出" })));
  expect(mocks.shared).toHaveBeenCalledWith({ shareToken: "local-test-token", origin: window.location.origin }, { timeoutMs: 120_000 });
  expect(mocks.export).not.toHaveBeenCalled();
});
