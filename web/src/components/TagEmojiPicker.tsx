import zh from "@emoji-mart/data/i18n/zh.json";
import data from "@emoji-mart/data/sets/15/native.json";
import { Picker } from "emoji-mart";
import { useEffect, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { withChineseEmojiKeywords } from "@/lib/emoji-search";
import { getThemeWithFallback, resolveTheme } from "@/utils/theme";

const searchableData = withChineseEmojiKeywords(data);

export default function TagEmojiPicker({ onSelect, disabled }: { onSelect: (emoji: string) => void; disabled: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const { userGeneralSetting } = useAuth();
  const theme = resolveTheme(getThemeWithFallback(userGeneralSetting?.theme)).includes("dark") ? "dark" : "light";

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const picker = new Picker({
      data: searchableData,
      i18n: { ...zh, search: "搜索（如 猫、书、cat）" },
      locale: "zh",
      theme,
      set: "native",
      emojiVersion: 15,
      dynamicWidth: true,
      autoFocus: false,
      previewPosition: "none",
      skinTonePosition: "search",
      onEmojiSelect: (emoji: { native: string }) => onSelect(emoji.native),
    }) as unknown as HTMLElement;
    picker.style.width = "100%";
    picker.style.height = "min(390px, 45vh)";
    picker.style.minHeight = "230px";
    host.appendChild(picker);
    return () => picker.remove();
  }, [onSelect, theme]);

  return <div ref={container} inert={disabled} aria-label="图标选择器" className="min-h-[230px] w-full min-w-0" />;
}
