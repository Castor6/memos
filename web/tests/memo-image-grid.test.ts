import { create } from "@bufbuild/protobuf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoService } from "@/components/MemoEditor/services/memoService";
import { createInitialState } from "@/components/MemoEditor/state";
import { memoCopyText } from "@/lib/memo-copy";
import { splitMemoImages } from "@/lib/memo-image-grid";
import { applyImageGridToggle, hasImageGridTag, resolveTagImageGrid } from "@/lib/tag";
import { AttachmentSchema } from "@/types/proto/api/v1/attachment_service_pb";
import { MemoSchema } from "@/types/proto/api/v1/memo_service_pb";
import {
  type UserSetting_TagMetadata,
  UserSetting_TagMetadataSchema,
  UserSetting_TagsSettingSchema,
} from "@/types/proto/api/v1/user_service_pb";

const clients = vi.hoisted(() => ({ getMemo: vi.fn(), updateMemo: vi.fn(), createMemo: vi.fn() }));
vi.mock("@/connect", () => ({ memoServiceClient: clients }));

const photo = create(AttachmentSchema, { name: "attachments/p1", filename: "photo.png", type: "image/png" });
const loose = create(AttachmentSchema, { name: "attachments/p2", filename: "loose.jpg", type: "image/jpeg" });
const doc = create(AttachmentSchema, { name: "attachments/d1", filename: "doc.pdf", type: "application/pdf" });
const inline = (attachment: typeof photo) =>
  `![${attachment.filename}](</file/${attachment.name}/${attachment.filename}> "memos:file:${attachment.type}")`;

describe("image grid tag rules", () => {
  it("matches exact and pattern rules", () => {
    const setting = create(UserSetting_TagsSettingSchema, {
      tags: { "photo/.*": create(UserSetting_TagMetadataSchema, { imageGrid: true }), work: create(UserSetting_TagMetadataSchema) },
    });
    expect(hasImageGridTag(["work", "photo/2026"], setting)).toBe(true);
    expect(hasImageGridTag(["work"], setting)).toBe(false);
    expect(hasImageGridTag(["photo/x"], undefined)).toBe(false);
  });
});

describe("image grid tag inheritance", () => {
  const meta = (init: Partial<UserSetting_TagMetadata> = {}) => create(UserSetting_TagMetadataSchema, init);
  const settingOf = (tags: Record<string, UserSetting_TagMetadata>) => create(UserSetting_TagsSettingSchema, { tags });
  const toggle = (tags: Record<string, UserSetting_TagMetadata>, tag: string, enabled: boolean) =>
    applyImageGridToggle(tags, tag, enabled, {
      create: (inherited) => create(UserSetting_TagMetadataSchema, inherited),
      isEmpty: (rule) => !rule.emoji && !rule.backgroundColor && !rule.blurContent && rule.imageGrid === undefined,
    });

  it("lets child tags follow the nearest ancestor that sets a value", () => {
    const setting = settingOf({ travel: meta({ imageGrid: true }), "travel/japan": meta({ emoji: "🗾" }) });
    expect(resolveTagImageGrid("travel", setting)).toEqual({ enabled: true });
    expect(resolveTagImageGrid("travel/japan", setting)).toEqual({ enabled: true, source: "travel" });
    expect(resolveTagImageGrid("travel/japan/tokyo", setting)).toEqual({ enabled: true, source: "travel" });
    expect(hasImageGridTag(["travel/korea"], setting)).toBe(true);
    expect(resolveTagImageGrid("work", setting)).toEqual({ enabled: false });
  });

  it("lets a child explicitly turn the grid off and pattern rules act as ancestors", () => {
    const setting = settingOf({
      travel: meta({ imageGrid: true }),
      "travel/notes": meta({ imageGrid: false }),
      "album/.*": meta({ imageGrid: true }),
    });
    expect(resolveTagImageGrid("travel/notes", setting)).toEqual({ enabled: false });
    expect(resolveTagImageGrid("travel/notes/x", setting)).toEqual({ enabled: false, source: "travel/notes" });
    expect(resolveTagImageGrid("album/2026/may", setting)).toEqual({ enabled: true });
  });

  it("resets child overrides when a parent is toggled and drops rules left empty", () => {
    const tags = { "travel/notes": meta({ imageGrid: false }), "travel/japan": meta({ emoji: "🗾", imageGrid: true }) };
    const next = toggle(tags, "travel", true);
    expect(next.travel.imageGrid).toBe(true);
    expect(next["travel/notes"]).toBeUndefined();
    expect(next["travel/japan"].emoji).toBe("🗾");
    expect(next["travel/japan"].imageGrid).toBeUndefined();
    expect(resolveTagImageGrid("travel/notes", settingOf(next))).toEqual({ enabled: true, source: "travel" });
  });

  it("stores only differences from the parent so toggling back restores following", () => {
    const off = toggle({ travel: meta({ imageGrid: true }) }, "travel/notes", false);
    expect(off["travel/notes"].imageGrid).toBe(false);
    const back = toggle(off, "travel/notes", true);
    expect(back["travel/notes"]).toBeUndefined();
    expect(toggle(back, "travel", false)).toEqual({});
  });

  it("keeps an empty exact rule that shields the tag from a pattern rule", () => {
    const next = toggle({ "photo/.*": meta({ imageGrid: true }) }, "photo/receipts", false);
    expect(next["photo/receipts"]).toBeDefined();
    expect(resolveTagImageGrid("photo/receipts", settingOf(next)).enabled).toBe(false);
  });
});

describe("splitMemoImages", () => {
  it("moves inline and unreferenced images to the grid without leaving gaps", () => {
    const content = `第一行\n\n${inline(photo)}\n\n第二行\n\n![外链](https://img.example.com/a.png)\n\n![录像](</file/v.mp4> "memos:file:video/mp4")`;
    const { body, images } = splitMemoImages(content, [photo, loose, doc]);
    expect(body).toBe('第一行\n\n第二行\n\n![录像](</file/v.mp4> "memos:file:video/mp4")');
    expect(images.map((image) => image.alt)).toEqual(["photo.png", "外链", "loose.jpg"]);
    expect(images[0].thumbnail).toContain("thumbnail=true");
    expect(images[1].thumbnail).toBe("https://img.example.com/a.png");
  });

  it("keeps linked images, code examples and surrounding text", () => {
    const content =
      "[![徽章](https://img.example.com/b.png)](https://example.com)\n\n```md\n![x](/file/x.png)\n```\n\n文字 ![小图](https://img.example.com/c.png) 后";
    const { body, images } = splitMemoImages(content, []);
    expect(images.map((image) => image.alt)).toEqual(["小图"]);
    expect(body).toBe("[![徽章](https://img.example.com/b.png)](https://example.com)\n\n```md\n![x](/file/x.png)\n```\n\n文字  后");
  });
});

describe("memoCopyText", () => {
  it("uses one newline per paragraph and keeps intentional empty lines", () => {
    expect(memoCopyText("第一行\n\n第二行\n\n&nbsp;\n\n第三行")).toBe("第一行\n第二行\n\n第三行");
  });

  it("turns hard breaks into newlines and decodes editor entities outside code", () => {
    expect(memoCopyText("甲\\\n乙  \n丙 &amp; 丁\n\n`&amp;`\n\n```\na &amp; b\n```")).toBe("甲\n乙\n丙 & 丁\n`&amp;`\n```\na &amp; b\n```");
  });

  it("keeps lists and Markdown formatting", () => {
    expect(memoCopyText("**重点**\n\n- 一\n- 二\n\n结尾")).toBe("**重点**\n- 一\n- 二\n结尾");
  });

  it("drops images only when requested", () => {
    const content = `说明\n\n${inline(photo)}\n\n文字 ![小图](https://img.example.com/c.png)\n\n结尾`;
    expect(memoCopyText(content)).toContain(inline(photo));
    expect(memoCopyText(content, { stripImages: true })).toBe("说明\n文字\n结尾");
  });
});

describe("editor bottom grid attachments", () => {
  beforeEach(() => {
    clients.updateMemo.mockReset();
    clients.updateMemo.mockImplementation(async ({ memo }) => memo);
  });

  it("keeps unreferenced images out of the body when the memo uses the image grid", () => {
    const memo = create(MemoSchema, { name: "memos/a", content: `正文\n\n${inline(photo)}`, attachments: [photo, loose, doc] });
    const grid = memoService.fromMemo(memo, { detachImages: true });
    expect(grid.metadata.gridAttachments).toEqual(["attachments/p2"]);
    expect(grid.content).not.toContain("loose.jpg");
    expect(grid.content).toContain("doc.pdf");
    const plain = memoService.fromMemo(memo);
    expect(plain.metadata.gridAttachments).toEqual([]);
    expect(plain.content).toContain("loose.jpg");
  });

  it("saves grid attachments without a body reference and still drops removed inline images", async () => {
    const memo = create(MemoSchema, {
      name: "memos/a",
      content: `正文\n\n${inline(photo)}`,
      attachments: [photo, loose],
      explicitTags: true,
    });
    clients.getMemo.mockResolvedValue(memo);
    const state = { ...createInitialState(), ...memoService.fromMemo(memo, { detachImages: true }) };
    state.content = "正文";
    await memoService.save(state, { memoName: memo.name });
    const saved = clients.updateMemo.mock.calls[0][0].memo;
    expect(saved.attachments.map((attachment: { name: string }) => attachment.name)).toEqual(["attachments/p2"]);
  });

  it("saves bottom grid images in grid order", async () => {
    const memo = create(MemoSchema, { name: "memos/a", content: "正文", attachments: [loose, photo], explicitTags: true });
    clients.getMemo.mockResolvedValue(memo);
    const state = { ...createInitialState(), ...memoService.fromMemo(memo, { detachImages: true }) };
    state.metadata.gridAttachments = ["attachments/p1", "attachments/p2"];
    await memoService.save(state, { memoName: memo.name });
    const saved = clients.updateMemo.mock.calls[0][0].memo;
    expect(saved.attachments.map((attachment: { name: string }) => attachment.name)).toEqual(["attachments/p1", "attachments/p2"]);
  });
});
