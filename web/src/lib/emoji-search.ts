import chineseKeywords from "@/data/emoji-zh.json";

/** Extend Emoji Mart's supported keyword data without changing its English search. */
export function withChineseEmojiKeywords<T extends { emojis: Record<string, { keywords?: string[] }> }>(data: T): T {
  const translations: Record<string, string[]> = chineseKeywords;
  return {
    ...data,
    emojis: Object.fromEntries(
      Object.entries(data.emojis).map(([id, emoji]) => [
        id,
        {
          ...emoji,
          keywords: [...new Set([...(emoji.keywords ?? []), ...(translations[id] ?? [])])],
        },
      ]),
    ),
  };
}
