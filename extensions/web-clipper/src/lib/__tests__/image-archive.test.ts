import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveMarkdownImages, type ImageArchiveEntry, imageArchivePlan, recoveredImageContent } from "@/background/image-archive";
import { InstanceError } from "@/lib/errors";
import { attachmentMarkdownUrl, createAttachment, getAttachment } from "@/lib/memos-client";

vi.mock("@/lib/memos-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memos-client")>()),
  createAttachment: vi.fn(),
  getAttachment: vi.fn(),
}));

const credentials = { instanceUrl: "https://memos.example.com", accessToken: "test-token" };
const source = "https://images.example.com/photo.webp";
const other = "https://images.example.com/other.png";
const download = vi.fn<typeof fetch>();
const current = vi.fn(async () => true);
const imageResponse = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp" } });
const uploaded = (id: string) => ({ name: `attachments/${id}`, filename: `clip-${id.slice(4, 12)}.webp` });
function recorder() {
  const snapshots: ImageArchiveEntry[][] = [];
  return {
    snapshots,
    persist: vi.fn(async (entries: ImageArchiveEntry[]) => {
      snapshots.push(structuredClone(entries));
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", download);
  download.mockImplementation(async () => imageResponse());
  current.mockResolvedValue(true);
  vi.mocked(createAttachment).mockImplementation(async (_credentials, input) => ({
    name: `attachments/${input.attachmentId}`,
    filename: input.filename,
  }));
  vi.mocked(getAttachment).mockResolvedValue(null);
});
afterEach(() => vi.unstubAllGlobals());

describe("image archive", () => {
  it("uploads one copy for repeated real Markdown images while preserving text, code and ordinary links", async () => {
    const content = `Before ![first](${source} "caption") middle\n\n> ![again](${source})\n\n[link](${source})\n\n\`![code](${other})\`\n\nAfter`;
    const plan = await imageArchivePlan(content, "save-one");
    expect(plan).toHaveLength(1);
    expect(plan[0]?.id).toMatch(/^clip[a-f0-9]{32}$/);
    expect(await imageArchivePlan(content, "save-one")).toEqual(plan);
    expect(await imageArchivePlan(content, "save-two")).not.toEqual(plan);
    const { persist, snapshots } = recorder();
    const result = await archiveMarkdownImages(content, plan, credentials, persist, current);
    const destination = attachmentMarkdownUrl(uploaded(plan[0]!.id));
    expect(result.content).toBe(
      content.replace(`![first](${source}`, `![first](${destination}`).replace(`![again](${source}`, `![again](${destination}`),
    );
    expect(result.names).toEqual([`attachments/${plan[0]!.id}`]);
    expect(result.failures).toEqual([]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(createAttachment).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(
      new URL(source),
      expect.objectContaining({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" }),
    );
    expect(snapshots.map((snapshot) => snapshot[0]?.status)).toEqual(["pending", "uploaded"]);
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(createAttachment).mock.invocationCallOrder[0]!);
  });

  it("keeps failed image URLs in place and returns their URL and reason while saving successful images", async () => {
    const content = `![bad](${source})\n\nText between\n\n![good](${other})`;
    download.mockRejectedValueOnce(new Error("download failed"));
    const plan = await imageArchivePlan(content, "partial");
    const result = await archiveMarkdownImages(content, plan, credentials, recorder().persist, current);
    expect(result.content).toContain(`![bad](${source})\n\nText between`);
    expect(result.content).not.toContain(`![good](${other})`);
    expect(result.failures).toEqual([{ url: source, reason: expect.stringContaining("下载失败") }]);
    expect(result.names).toHaveLength(1);
  });

  it("reuses uploaded entries and reconciles pending uploads by GET without downloading or uploading again", async () => {
    const content = `![one](${source}) ![two](${other})`;
    const plan = await imageArchivePlan(content, "resume");
    plan[0] = { ...plan[0]!, status: "uploaded", attachment: uploaded(plan[0]!.id) };
    plan[1] = { ...plan[1]!, status: "pending" };
    vi.mocked(getAttachment).mockResolvedValue(uploaded(plan[1]!.id));
    const result = await archiveMarkdownImages(content, plan, credentials, recorder().persist, current);
    expect(result.names).toEqual(plan.map((entry) => `attachments/${entry.id}`));
    expect(result.content).toBe(
      recoveredImageContent(
        content,
        plan,
        plan.map((entry) => uploaded(entry.id)),
      ),
    );
    expect(download).not.toHaveBeenCalled();
    expect(createAttachment).not.toHaveBeenCalled();
    expect(getAttachment).toHaveBeenCalledExactlyOnceWith(credentials, plan[1]!.id);
  });

  it("recovers after the first upload is persisted and the next upload response and GET are unavailable", async () => {
    const content = `![one](${source}) then ![two](${other})`;
    const plan = await imageArchivePlan(content, "interrupted");
    vi.mocked(createAttachment).mockResolvedValueOnce(uploaded(plan[0]!.id)).mockRejectedValueOnce(new InstanceError("timeout"));
    vi.mocked(getAttachment).mockRejectedValueOnce(new InstanceError("unreachable"));
    const { persist, snapshots } = recorder();
    await expect(archiveMarkdownImages(content, plan, credentials, persist, current)).rejects.toMatchObject({ kind: "unreachable" });
    const saved = snapshots.at(-1)!;
    expect(saved.map((entry) => entry.status)).toEqual(["uploaded", "pending"]);
    vi.mocked(getAttachment).mockResolvedValueOnce(uploaded(plan[1]!.id));
    const result = await archiveMarkdownImages(content, saved, credentials, persist, current);
    expect(result.failures).toEqual([]);
    expect(result.names).toHaveLength(2);
    expect(download).toHaveBeenCalledTimes(2);
    expect(createAttachment).toHaveBeenCalledTimes(2);
  });

  it("does not retry a POST while GET cannot establish a pending upload's outcome", async () => {
    const content = `![one](${source})`;
    const plan = await imageArchivePlan(content, "unknown");
    plan[0]!.status = "pending";
    vi.mocked(getAttachment).mockRejectedValueOnce(new InstanceError("timeout"));
    await expect(archiveMarkdownImages(content, plan, credentials, recorder().persist, current)).rejects.toMatchObject({ kind: "timeout" });
    expect(download).not.toHaveBeenCalled();
    expect(createAttachment).not.toHaveBeenCalled();
  });

  it("does not upload if persisting the pending boundary fails", async () => {
    const content = `![one](${source})`;
    const plan = await imageArchivePlan(content, "storage-failure");
    await expect(
      archiveMarkdownImages(content, plan, credentials, vi.fn().mockRejectedValue(new Error("storage unavailable")), current),
    ).rejects.toThrow("storage unavailable");
    expect(createAttachment).not.toHaveBeenCalled();
  });

  it.each([
    "https://127.0.0.1/a.png",
    "https://192.168.1.10/a.png",
    "https://[::1]/a.png",
    "https://service.internal/a.png",
    "https://user:password@example.com/a.png",
    "http://images.example.com/a.png",
  ])("does not fetch unsafe address %s", async (url) => {
    const content = `![unsafe](${url})`;
    const result = await archiveMarkdownImages(
      content,
      await imageArchivePlan(content, "unsafe"),
      credentials,
      recorder().persist,
      current,
    );
    expect(result.content).toBe(content);
    expect(result.failures).toEqual([{ url, reason: expect.any(String) }]);
    expect(download).not.toHaveBeenCalled();
    expect(createAttachment).not.toHaveBeenCalled();
  });

  it.each(["declared size", "stream size", "active format"])("rejects an image with disallowed %s", async (kind) => {
    const response =
      kind === "stream size"
        ? new Response(new Uint8Array(10 * 1024 * 1024 + 1), { headers: { "content-type": "image/png" } })
        : new Response("image", {
            headers: {
              "content-type": kind === "active format" ? "image/svg+xml" : "image/png",
              "content-length": kind === "declared size" ? String(10 * 1024 * 1024 + 1) : "5",
            },
          });
    download.mockResolvedValueOnce(response);
    const content = `![image](${source})`;
    const result = await archiveMarkdownImages(
      content,
      await imageArchivePlan(content, "too-large"),
      credentials,
      recorder().persist,
      current,
    );
    expect(result.content).toBe(content);
    expect(result.failures).toHaveLength(1);
    expect(createAttachment).not.toHaveBeenCalled();
  });

  it("skips previously archived local attachment URLs", async () => {
    expect(await imageArchivePlan("![local](/file/attachments/already/image.png)", "already")).toEqual([]);
  });
});
