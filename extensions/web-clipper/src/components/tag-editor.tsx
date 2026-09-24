import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type TagEditorProps = {
  tags: string[];
  suggestions: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
};

function validTag(tag: string) {
  return (
    tag.length > 0 &&
    new TextEncoder().encode(tag).length <= 256 &&
    !Array.from(tag).some((char) => [10, 13, 0, 31].includes(char.charCodeAt(0)))
  );
}

export function TagEditor({ tags, suggestions, onChange, disabled = false, loading = false, error, onRetry }: TagEditorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const id = useId();
  const query = search.trim();
  const known = Array.from(new Set(suggestions.map((tag) => tag.trim()).filter(validTag)));
  const candidates = known
    .filter((tag) => !tags.includes(tag) && tag.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .map((tag) => ({ tag, create: false }));
  if (validTag(query) && !known.includes(query) && !tags.includes(query)) candidates.push({ tag: query, create: true });
  const selectedIndex = Math.min(activeIndex, candidates.length - 1);
  const limitReached = tags.length >= 100;
  const invalidQuery = query.length > 0 && !validTag(query);

  useEffect(() => {
    if (open) searchRef.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, search, open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };
  const add = (tag: string) => {
    const value = tag.trim();
    if (disabled || limitReached || !validTag(value) || tags.includes(value)) return;
    onChange([...tags, value]);
    setSearch("");
    setActiveIndex(0);
    close();
  };

  return (
    <section aria-label="标签管理" className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex max-w-full items-center gap-1 rounded-md bg-accent py-1 ps-2.5 pe-1 text-sm break-words text-accent-foreground"
          >
            <span className="min-w-0">{tag}</span>
            <button
              type="button"
              disabled={disabled}
              aria-label={`移除标签 ${tag}`}
              className="shrink-0 rounded px-1 hover:bg-muted disabled:opacity-50"
              onClick={() => onChange(tags.filter((value) => value !== tag))}
            >
              <span aria-hidden="true">×</span>
            </button>
          </span>
        ))}
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-expanded={open}
          aria-controls={`${id}-editor`}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
          onClick={() => {
            setOpen(!open);
            setActiveIndex(0);
          }}
        >
          ＋ 添加标签
        </button>
      </div>
      {open && (
        <div id={`${id}-editor`} className="min-w-0 rounded-lg border border-border bg-popover p-2 text-popover-foreground">
          <input
            ref={searchRef}
            aria-label="搜索或新建标签"
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-controls={`${id}-list`}
            aria-activedescendant={selectedIndex >= 0 ? `${id}-option-${selectedIndex}` : undefined}
            aria-invalid={invalidQuery}
            aria-describedby={invalidQuery || limitReached ? `${id}-validation` : undefined}
            placeholder="搜索或新建标签"
            className="w-full min-w-0 rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={search}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onChange={(event) => {
              setSearch(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
              if ((event.key === "ArrowDown" || event.key === "ArrowUp") && candidates.length > 0) {
                event.preventDefault();
                setActiveIndex((selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                const selected = candidates[selectedIndex];
                if (selected) add(selected.tag);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
            }}
          />
          {loading && (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              正在加载已有标签…
            </p>
          )}
          {error && (
            <div role="status" className="mt-2 text-xs text-muted-foreground">
              <p className="break-words">{error}，仍可新建标签。</p>
              {onRetry && (
                <button type="button" className="mt-1 underline" disabled={loading} onClick={onRetry}>
                  重试加载标签
                </button>
              )}
            </div>
          )}
          {(invalidQuery || limitReached) && (
            <p id={`${id}-validation`} role="alert" className="mt-2 text-xs text-destructive">
              {limitReached ? "最多添加 100 个标签。" : "标签不能包含换行或控制字符，长度不能超过 256 字节。"}
            </p>
          )}
          <div ref={listRef} id={`${id}-list`} role="listbox" aria-label="标签候选" className="mt-1 flex max-h-40 flex-col overflow-y-auto">
            {candidates.map(({ tag, create }, index) => (
              <button
                key={tag}
                id={`${id}-option-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === selectedIndex}
                disabled={limitReached}
                className={cn(
                  "rounded-md p-2 text-left text-xs break-words hover:bg-muted disabled:opacity-50",
                  index === selectedIndex && "bg-muted",
                )}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => add(tag)}
              >
                {create ? `新建“${tag}”` : tag}
              </button>
            ))}
            {candidates.length === 0 && !invalidQuery && (
              <p className="p-2 text-xs text-muted-foreground">{query && tags.includes(query) ? "标签已添加" : "输入名称新建标签"}</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
