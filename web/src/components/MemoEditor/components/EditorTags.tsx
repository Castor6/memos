import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuth } from "@/contexts/AuthContext";
import { useMemoFilterContext } from "@/contexts/MemoFilterContext";
import { useTagCounts } from "@/hooks/useUserQueries";
import { findTagMetadata } from "@/lib/tag";
import { useEditorContext, useEditorSelector } from "../state";

const EMPTY_TAGS: string[] = [];

export default function EditorTags({ editing }: { editing: boolean }) {
  const { actions, dispatch } = useEditorContext();
  const tags = useEditorSelector((state) => state.metadata.tags ?? EMPTY_TAGS);
  const { userTagsSetting } = useAuth();
  const { filters } = useMemoFilterContext();
  const { data: counts = {} } = useTagCounts(true);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const selectedFilter = filters.filter((filter) => filter.factor === "tagSearch").map((filter) => filter.value);
  const filterKey = selectedFilter.join("\u0000");
  const previousFilter = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!editing && previousFilter.current !== filterKey) {
      dispatch(actions.setMetadata({ tags: Array.from(new Set([...tags, ...selectedFilter])) }));
      previousFilter.current = filterKey;
    }
  }, [editing, filterKey, tags, selectedFilter, dispatch, actions]);
  const add = (tag: string) => {
    const value = tag.trim();
    if (value && !tags.includes(value)) dispatch(actions.setMetadata({ tags: [...tags, value] }));
    setSearch("");
    setOpen(false);
  };
  const emoji = (tag: string) => (userTagsSetting ? findTagMetadata(tag, userTagsSetting)?.emoji : "");
  const known = Array.from(new Set([...Object.keys(counts), ...Object.keys(userTagsSetting?.tags || {})]));
  return (
    <div className="w-full flex flex-wrap items-center gap-2 border-b pb-2" aria-label="标签管理">
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          className="rounded-full bg-accent px-2.5 py-1 text-sm"
          aria-label={`移除标签 ${tag}`}
          onClick={() => dispatch(actions.setMetadata({ tags: tags.filter((value) => value !== tag) }))}
        >
          {emoji(tag)} {tag} <span aria-hidden>×</span>
        </button>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="px-2 py-1 text-sm text-muted-foreground rounded-md hover:bg-muted">＋ 添加标签</PopoverTrigger>
        <PopoverContent align="start" className="p-3 w-64">
          <Input
            autoFocus
            aria-label="搜索或新建标签"
            placeholder="搜索或新建标签"
            value={search}
            maxLength={100}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                add(search);
              }
            }}
          />
          <div className="max-h-52 overflow-auto mt-2 flex flex-col">
            {known
              .filter((tag) => !tags.includes(tag) && tag.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
              .map((tag) => (
                <button key={tag} type="button" className="p-2 text-left text-sm hover:bg-muted rounded" onClick={() => add(tag)}>
                  {emoji(tag)} {tag}
                </button>
              ))}
            {search.trim() && !known.includes(search.trim()) && (
              <button type="button" className="p-2 text-left text-sm text-primary" onClick={() => add(search)}>
                新建“{search.trim()}”
              </button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
