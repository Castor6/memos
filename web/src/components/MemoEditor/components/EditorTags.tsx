import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuth } from "@/contexts/AuthContext";
import { useMemoFilterContext } from "@/contexts/MemoFilterContext";
import { useTagCounts } from "@/hooks/useUserQueries";
import { findTagMetadata, getTagStyle } from "@/lib/tag";
import { cn } from "@/lib/utils";
import { useEditorContext, useEditorSelector } from "../state";

const EMPTY_TAGS: string[] = [];

export default function EditorTags({
  editing,
  ready = true,
  onFocusContent,
}: {
  editing: boolean;
  ready?: boolean;
  onFocusContent?: () => void;
}) {
  const { actions, dispatch } = useEditorContext();
  const tags = useEditorSelector((state) => state.metadata.tags ?? EMPTY_TAGS);
  const { userTagsSetting } = useAuth();
  const { filters } = useMemoFilterContext();
  const { data: counts = {} } = useTagCounts(true);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedFilter = filters.filter((filter) => filter.factor === "tagSearch").map((filter) => filter.value);
  const filterKey = selectedFilter.join("\u0000");
  const autoTags = useRef(new Set<string>());
  const previousFilter = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (ready && !editing && previousFilter.current !== filterKey) {
      const retained = tags.filter((tag) => !autoTags.current.has(tag) || selectedFilter.includes(tag));
      autoTags.current = new Set([
        ...[...autoTags.current].filter((tag) => selectedFilter.includes(tag)),
        ...selectedFilter.filter((tag) => !retained.includes(tag)),
      ]);
      dispatch(actions.setMetadata({ tags: Array.from(new Set([...retained, ...selectedFilter])) }));
      previousFilter.current = filterKey;
    }
  }, [ready, editing, filterKey, tags, selectedFilter, dispatch, actions]);
  const add = (tag: string) => {
    const value = tag.trim();
    autoTags.current.delete(value);
    if (value && !tags.includes(value)) dispatch(actions.setMetadata({ tags: [...tags, value] }));
    setSearch("");
    setOpen(false);
  };
  const emoji = (tag: string) => (userTagsSetting ? findTagMetadata(tag, userTagsSetting)?.emoji : "");
  const tagStyle = (tag: string) => getTagStyle(userTagsSetting ? findTagMetadata(tag, userTagsSetting) : undefined);
  const known = Array.from(new Set([...Object.keys(counts), ...Object.keys(userTagsSetting?.tags || {})]));
  const query = search.trim();
  const candidates = known
    .filter((tag) => !tags.includes(tag) && tag.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .map((tag) => ({ tag, create: false }));
  if (query && !known.includes(query) && !tags.includes(query)) candidates.push({ tag: query, create: true });
  const selectedIndex = Math.min(activeIndex, candidates.length - 1);
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !selected) return;
    const itemRect = selected.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    if (itemRect.top < listRect.top) list.scrollTop -= listRect.top - itemRect.top;
    else if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom;
  }, [open, selectedIndex, search]);
  return (
    <div className="w-full flex flex-wrap items-center gap-2 border-b pb-2" aria-label="标签管理">
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          className="rounded-full bg-accent px-2.5 py-1 text-sm"
          data-tag={tag}
          style={tagStyle(tag)}
          aria-label={`移除标签 ${tag}`}
          onClick={() => dispatch(actions.setMetadata({ tags: tags.filter((value) => value !== tag) }))}
        >
          {emoji(tag)} {tag} <span aria-hidden>×</span>
        </button>
      ))}
      <Popover
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          setActiveIndex(0);
        }}
      >
        <PopoverTrigger
          ref={triggerRef}
          className="px-2 py-1 text-sm text-muted-foreground rounded-md hover:bg-muted"
          onKeyDown={(event) => {
            if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !open && onFocusContent) {
              event.preventDefault();
              onFocusContent();
            }
          }}
        >
          ＋ 添加标签
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="p-3 w-64"
          initialFocus={() => {
            searchRef.current?.focus({ preventScroll: true });
            return false;
          }}
          finalFocus={() => {
            triggerRef.current?.focus({ preventScroll: true });
            return false;
          }}
        >
          <Input
            ref={searchRef}
            aria-label="搜索或新建标签"
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={selectedIndex >= 0 ? `${listId}-${selectedIndex}` : undefined}
            placeholder="搜索或新建标签"
            value={search}
            maxLength={100}
            onChange={(event) => {
              setSearch(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if ((event.key === "ArrowDown" || event.key === "ArrowUp") && candidates.length > 0) {
                event.preventDefault();
                setActiveIndex((selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (selectedIndex >= 0) add(candidates[selectedIndex].tag);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <div ref={listRef} id={listId} role="listbox" aria-label="标签候选" className="max-h-52 overflow-auto mt-2 flex flex-col">
            {candidates.map(({ tag, create }, index) => (
              <button
                key={tag}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                className={cn(
                  "p-2 text-left text-sm hover:bg-muted rounded",
                  index === selectedIndex && "bg-muted",
                  create && "text-primary",
                )}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => add(tag)}
              >
                {create ? (
                  `新建“${tag}”`
                ) : (
                  <span data-tag={tag} style={tagStyle(tag)}>
                    {emoji(tag)} {tag}
                  </span>
                )}
              </button>
            ))}
            {candidates.length === 0 && <p className="p-2 text-sm text-muted-foreground">没有可添加的标签</p>}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
