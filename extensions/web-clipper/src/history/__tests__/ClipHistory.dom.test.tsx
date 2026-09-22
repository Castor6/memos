import { beforeEach, describe, expect, it } from "vitest";
import { ClipHistory } from "@/history/ClipHistory";
import type { ClipRecord } from "@/lib/clip-records";
import { browserMock } from "@/test/browser-mock";
import { renderWithUser, screen } from "@/test/render";

const records: ClipRecord[] = [
  {
    schemaVersion: 1,
    id: "clip_latest",
    dedupeKey: `v1:${"a".repeat(64)}`,
    instanceUrl: "https://memos.example.com",
    sourceUrl: "https://example.com/articles/web-clipping",
    sourceTitle: "A practical guide to web clipping",
    selection: { markdown: "Keep the thing the user deliberately selected.", imageCount: 2 },
    memoContent: "> Keep the thing the user deliberately selected.\n\n[A practical guide](https://example.com)",
    visibility: "PRIVATE",
    memoName: "memos/42",
    memoUrl: "https://memos.example.com/m/42",
    savedAt: 200,
  },
  {
    schemaVersion: 1,
    id: "clip_older",
    dedupeKey: `v1:${"b".repeat(64)}`,
    instanceUrl: "https://notes.example.net",
    sourceUrl: "https://another.example.org/reference",
    sourceTitle: "Reference notes",
    memoContent: "A plain page save",
    visibility: "PROTECTED",
    memoName: "memos/9",
    memoUrl: "https://notes.example.net/m/9",
    savedAt: 100,
  },
];

describe("ClipHistory", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/src/options/index.html?view=history");
    browserMock.runtime.sendMessage.mockResolvedValue({ ok: true, records });
  });

  it("shows saved clips in a searchable master-detail history", async () => {
    const { user } = renderWithUser(<ClipHistory />);

    expect(await screen.findByRole("heading", { name: "Saved clips" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "A practical guide to web clipping" })).toBeInTheDocument();
    expect(screen.getAllByText("Keep the thing the user deliberately selected.")).toHaveLength(2);
    expect(screen.getByText(/2 selected images/i)).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes("[A practical guide](https://example.com)"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open source/i })).toHaveAttribute("href", "https://example.com/articles/web-clipping");
    expect(screen.getByRole("link", { name: /open memo/i })).toHaveAttribute("href", "https://memos.example.com/m/42");

    await user.type(screen.getByRole("searchbox"), "Reference notes");
    expect(await screen.findByRole("heading", { name: "Reference notes" })).toBeInTheDocument();
    expect(screen.getAllByText("A plain page save")).toHaveLength(2);
  });

  it("shows sync failures instead of an empty or stale local history", async () => {
    browserMock.runtime.sendMessage.mockResolvedValue({ ok: false, errorKind: "capture-unsupported" });
    const { user } = renderWithUser(<ClipHistory />);
    expect(await screen.findByRole("alert")).toHaveTextContent("服务器尚不支持同步");
    expect(screen.queryByRole("heading", { name: "A practical guide to web clipping" })).not.toBeInTheDocument();
    browserMock.runtime.sendMessage.mockResolvedValue({ ok: true, records: [] });
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(/旧版仅存本地的历史不会自动导入/)).toBeInTheDocument();
  });
});
