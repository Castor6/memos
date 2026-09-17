import { BookTextIcon, CodeXmlIcon, EraserIcon, HighlighterIcon, LinkIcon, QuoteIcon, RedoIcon, UndoIcon } from "lucide-react";
import { type RefObject, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuth } from "@/contexts/AuthContext";
import type { EditorController } from "../types/editorController";

export default function QuickTools({ controllerRef }: { controllerRef: RefObject<EditorController | null> }) {
  const { userGeneralSetting } = useAuth();
  const [search, setSearch] = useState("");
  const [wordsOpen, setWordsOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setURL] = useState("");
  return (
    <div className="flex shrink-0 items-center gap-0.5" role="toolbar" aria-label="更多编辑操作">
      {(
        [
          { action: "undo", label: "撤销", icon: UndoIcon },
          { action: "redo", label: "重做", icon: RedoIcon },
          { action: "highlight", label: "高亮", icon: HighlighterIcon },
          { action: "clear", label: "清除格式", icon: EraserIcon },
          { action: "blockquote", label: "引用段落", icon: QuoteIcon },
          { action: "code", label: "行内代码", icon: CodeXmlIcon },
        ] as const
      ).map(({ action, label, icon: Icon }) => (
        <button
          type="button"
          key={action}
          className="p-1.5 rounded hover:bg-muted text-muted-foreground"
          title={label}
          aria-label={label}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => controllerRef.current?.edit?.(action)}
        >
          <Icon className="size-4" />
        </button>
      ))}
      <Popover open={linkOpen} onOpenChange={setLinkOpen}>
        <PopoverTrigger className="p-1.5 rounded hover:bg-muted text-muted-foreground" aria-label="插入链接" title="插入链接">
          <LinkIcon className="size-4" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="p-3 w-64"
          finalFocus={() => {
            controllerRef.current?.focus();
            return false;
          }}
        >
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!/^https?:\/\//i.test(url)) return;
              controllerRef.current?.formatting?.run("link", { url });
              setLinkOpen(false);
              setURL("");
            }}
          >
            <Input aria-label="链接地址" placeholder="https://" value={url} onChange={(event) => setURL(event.target.value)} />
            <Button type="submit" disabled={!/^https?:\/\//i.test(url)}>
              插入
            </Button>
          </form>
        </PopoverContent>
      </Popover>
      <Popover open={wordsOpen} onOpenChange={setWordsOpen}>
        <PopoverTrigger aria-label="常用词" title="常用词" className="p-1.5 text-muted-foreground rounded hover:bg-muted">
          <BookTextIcon className="size-4" />
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
            {(userGeneralSetting?.commonWords || [])
              .filter((word) => word.toLocaleLowerCase().startsWith(search.toLocaleLowerCase()))
              .map((word) => (
                <button
                  key={word}
                  type="button"
                  className="text-left p-2 text-sm hover:bg-muted"
                  onClick={() => {
                    controllerRef.current?.insertText?.(word);
                    setWordsOpen(false);
                    setSearch("");
                  }}
                >
                  {word}
                </button>
              ))}
            {!userGeneralSetting?.commonWords.length && (
              <p className="text-sm text-muted-foreground p-2">请在设置 → 偏好设置中配置常用词。</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
