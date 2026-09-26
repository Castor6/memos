import { BookTextIcon } from "lucide-react";
import { type RefObject, useState } from "react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuth } from "@/contexts/AuthContext";
import type { EditorController } from "../types/editorController";
import { TOOL_TRIGGER } from "./CommandMenu";

export default function QuickTools({
  controllerRef,
  compact = false,
}: {
  controllerRef: RefObject<EditorController | null>;
  compact?: boolean;
}) {
  const { userGeneralSetting } = useAuth();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const words = userGeneralSetting?.commonWords || [];
  const matches = words.filter((word) => word.toLocaleLowerCase().startsWith(search.toLocaleLowerCase()));
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) controllerRef.current?.formatting?.captureSelection?.();
        else controllerRef.current?.formatting?.restoreSelection?.();
        setOpen(next);
      }}
    >
      <PopoverTrigger aria-label="常用词" title="常用词" className={TOOL_TRIGGER}>
        <BookTextIcon className="size-4" />
        <span className={compact ? "sr-only" : ""}>常用词</span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="p-3 w-64"
        finalFocus={() => {
          controllerRef.current?.focus();
          return false;
        }}
      >
        <Input
          autoFocus
          placeholder="输入中文或英文前缀"
          aria-label="搜索常用词"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="mt-2 max-h-52 overflow-auto flex flex-col">
          {matches.map((word) => (
            <button
              key={word}
              type="button"
              className="text-left min-h-11 p-2 text-sm hover:bg-muted"
              onClick={() => {
                controllerRef.current?.formatting?.restoreSelection?.();
                controllerRef.current?.insertText?.(word);
                setOpen(false);
                setSearch("");
              }}
            >
              {word}
            </button>
          ))}
          {!words.length && <p className="text-sm text-muted-foreground p-2">请在设置 → 偏好设置中配置常用词。</p>}
          {words.length > 0 && !matches.length && <p className="text-sm text-muted-foreground p-2">没有匹配的常用词。</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
