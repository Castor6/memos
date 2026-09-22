import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MemoArchiveSection from "@/components/Settings/MemoArchiveSection";
import { MAX_MEMO_ARCHIVE_BYTES } from "@/hooks/useMemoArchive";
import { downloadMemoArchive } from "@/lib/memo-archive";
import en from "@/locales/en.json";
import zh from "@/locales/zh-Hans.json";
import hant from "@/locales/zh-Hant.json";

const mocks = vi.hoisted(() => ({ exportArchive: vi.fn(), importArchive: vi.fn(), refetchSettings: vi.fn() }));
vi.mock("@/connect", () => ({ memoTransferServiceClient: { exportMemoArchive: mocks.exportArchive, importMemoArchive: mocks.importArchive } }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ refetchSettings: mocks.refetchSettings }) }));
vi.mock("@/hooks/useAttachmentQueries", () => ({ attachmentKeys: { all: ["attachments"] } }));
vi.mock("@/hooks/useMemoQueries", () => ({ memoKeys: { all: ["memos"] } }));
vi.mock("@/hooks/useUserQueries", () => ({ userKeys: { all: ["users"] } }));
vi.mock("@/utils/i18n", () => ({ useTranslate: () => (key: string, values: Record<string, unknown> = {}) => {
  const value = en.setting["memo-archive"][key.replace("setting.memo-archive.", "") as keyof typeof en.setting["memo-archive"]] || key;
  return value.replace(/{{(\w+)}}/g, (_, name: string) => String(values[name] ?? ""));
} }));

const mount = () => {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(<QueryClientProvider client={queryClient}><MemoArchiveSection /></QueryClientProvider>);
  return { invalidate };
};
const archiveFile = (name = "memos.zip", size?: number) => {
  const file = new File([new Uint8Array([80, 75, 3, 4])], name, { type: "application/zip" });
  const arrayBuffer = vi.fn().mockResolvedValue(new Uint8Array([80, 75, 3, 4]).buffer);
  Object.defineProperty(file, "arrayBuffer", { value: arrayBuffer });
  if (size !== undefined) Object.defineProperty(file, "size", { value: size });
  return { file, arrayBuffer };
};
const choose = (file: File) => fireEvent.change(screen.getByLabelText("ZIP file (up to 128 MiB)"), { target: { files: [file] } });

beforeEach(() => {
  mocks.refetchSettings.mockResolvedValue(undefined);
  mocks.importArchive.mockResolvedValue({ imported: 1, skipped: 0, attachments: 1, warnings: [], errors: [] });
  mocks.exportArchive.mockResolvedValue({ content: new Uint8Array([80, 75]), filename: "memos-test.zip", memoCount: 2, attachmentCount: 1, warnings: [] });
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:archive-test"), revokeObjectURL: vi.fn() }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("memo archive settings", () => {
  it("explains ownership and duplicates, requires an explicit import, and shows partial results", async () => {
    let finish!: (result: unknown) => void;
    mocks.importArchive.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { invalidate } = mount();
    expect(screen.getByText(/Existing memo IDs are skipped and never overwritten/)).toBeInTheDocument();
    expect(screen.getByText(/Upstream Memos spaces are imported into the space currently selected/)).toBeInTheDocument();
    const { file } = archiveFile();
    choose(file);
    expect(mocks.importArchive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Import into this account" }));
    await waitFor(() => expect(mocks.importArchive).toHaveBeenCalledWith({ content: new Uint8Array([80, 75, 3, 4]) }));
    expect(screen.getByRole("button", { name: "Download ZIP" })).toBeDisabled();
    expect(screen.getByLabelText("ZIP file (up to 128 MiB)")).toBeDisabled();
    await act(async () => finish({ imported: 2, skipped: 3, attachments: 4, warnings: ["old space mapped"], errors: ["memos/five: invalid attachment"] }));
    expect(await screen.findByText("Import finished with failed items")).toBeInTheDocument();
    expect(screen.getByText("Imported 2 memos, skipped 3 existing memos and added 4 attachments.")).toBeInTheDocument();
    expect(screen.getByText("memos/five: invalid attachment")).toBeInTheDocument();
    expect(screen.getByText("old space mapped")).toBeInTheDocument();
    expect(mocks.refetchSettings).toHaveBeenCalledOnce();
    for (const key of ["memos", "attachments", "users"]) expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] });
  });

  it.each([["memos.zip", 0], ["memos.zip", MAX_MEMO_ARCHIVE_BYTES + 1], ["notes.txt", 20]] as const)("rejects %s of size %s before reading it", (name, size) => {
    mount();
    const { file, arrayBuffer } = archiveFile(name, size);
    choose(file);
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a non-empty .zip file no larger than 128 MiB.");
    expect(screen.getByRole("button", { name: "Import into this account" })).toBeDisabled();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(mocks.importArchive).not.toHaveBeenCalled();
  });

  it("downloads the server ZIP and displays any omitted-file warning", async () => {
    mocks.exportArchive.mockResolvedValueOnce({ content: new Uint8Array([80, 75]), filename: "memos-test.zip", memoCount: 2, attachmentCount: 1, warnings: ["missing image"] });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Download ZIP" }));
    expect(await screen.findByText("Downloaded 2 memos and 1 attachments.")).toBeInTheDocument();
    expect(screen.getByText("missing image")).toBeInTheDocument();
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: "application/zip", size: 2 }));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("shows a failed request without claiming success and allows retrying the selected file", async () => {
    mocks.importArchive.mockRejectedValueOnce(new Error("invalid archive manifest"));
    mount();
    choose(archiveFile().file);
    fireEvent.click(screen.getByRole("button", { name: "Import into this account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid archive manifest");
    expect(screen.queryByText("Import completed")).toBeNull();
    expect(screen.getByRole("button", { name: "Import into this account" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Import into this account" }));
    expect(await screen.findByText("Import completed")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports export errors", async () => {
    mocks.exportArchive.mockRejectedValueOnce(new Error("archive exceeds limit"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Download ZIP" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("archive exceeds limit");
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it("provides every archive string in English and both Chinese locales", () => {
    const keys = Object.keys(en.setting["memo-archive"]).sort();
    expect(Object.keys(zh.setting["memo-archive"]).sort()).toEqual(keys);
    expect(Object.keys(hant.setting["memo-archive"]).sort()).toEqual(keys);
  });
});

it("releases the download object URL after the browser has started saving", () => {
  vi.useFakeTimers();
  downloadMemoArchive(new Uint8Array([80, 75]), "archive.zip");
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60_000);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:archive-test");
});
