import data from "@emoji-mart/data/sets/15/native.json";
import { init, SearchIndex } from "emoji-mart";
import { describe, expect, it } from "vitest";
import keywords from "@/data/emoji-zh.json";
import { withChineseEmojiKeywords } from "@/lib/emoji-search";

describe("Chinese emoji search", () => {
  it("covers the installed emoji set and leaves its original data untouched", () => {
    const original = [...data.emojis.cat.keywords];
    const translated = withChineseEmojiKeywords(data);
    expect(Object.keys(keywords).length).toBeGreaterThan(1800);
    expect(translated.emojis.cat.keywords).toContain("猫");
    expect(data.emojis.cat.keywords).toEqual(original);
  });
  it("uses the real Emoji Mart search for Chinese and English", async () => {
    await init({ data: withChineseEmojiKeywords(data) });
    const ids = async (query: string) => (await SearchIndex.search(query) ?? []).map((emoji: { id: string }) => emoji.id);
    expect(await ids("猫")).toContain("cat");
    expect(await ids("cat")).toContain("cat");
    expect((await ids("书")).length).toBeGreaterThan(0);
    expect((await ids("电脑")).length).toBeGreaterThan(0);
  });
});
