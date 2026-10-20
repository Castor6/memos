import { useMemo } from "react";
import { useTranslate } from "@/utils/i18n";
import { countMemoWords } from "@/utils/word-count";
import { useEditorSelector } from "../state";

export const EditorWordCount = () => {
  const t = useTranslate();
  const content = useEditorSelector((state) => state.content);
  const count = useMemo(() => countMemoWords(content), [content]);
  return <span className="px-1 text-xs tabular-nums text-muted-foreground">{t("memo.word-count", { count })}</span>;
};
