import {
  AlignLeftIcon,
  BoldIcon,
  CodeIcon,
  EraserIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  HighlighterIcon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  ListTodoIcon,
  Minimize2Icon,
  QuoteIcon,
  SquareCodeIcon,
  StrikethroughIcon,
  TypeIcon,
  UnderlineIcon,
} from "lucide-react";
import type { RefObject } from "react";
import { cn } from "@/lib/utils";
import { useEditorActiveState } from "../hooks";
import type { EditorController } from "../types";
import { type CommandItem, CommandMenu, TOOL_TRIGGER } from "./CommandMenu";

export const PARAGRAPH_ITEMS: CommandItem[] = [
  { id: "paragraph", label: "正文", icon: AlignLeftIcon },
  { id: "heading1", label: "标题 1", icon: Heading1Icon },
  { id: "heading2", label: "标题 2", icon: Heading2Icon },
  { id: "heading3", label: "标题 3", icon: Heading3Icon },
  { id: "blockquote", label: "引用段落", icon: QuoteIcon },
  { id: "codeBlock", label: "代码块", icon: SquareCodeIcon },
];
export const LIST_ITEMS: CommandItem[] = [
  { id: "bulletList", label: "无序列表", icon: ListIcon },
  { id: "orderedList", label: "有序列表", icon: ListOrderedIcon },
  { id: "taskList", label: "待办列表", icon: ListTodoIcon },
];
export const TEXT_ITEMS: CommandItem[] = [
  { id: "bold", label: "加粗", icon: BoldIcon },
  { id: "italic", label: "斜体", icon: ItalicIcon },
  { id: "underline", label: "下划线", icon: UnderlineIcon },
  { id: "strikethrough", label: "删除线", icon: StrikethroughIcon },
  { id: "highlight", label: "高亮", icon: HighlighterIcon },
  { id: "code", label: "行内代码", icon: CodeIcon },
  { id: "clearFormatting", label: "清除文字格式", icon: EraserIcon },
];

export function FormattingToolbar({
  controllerRef,
  onExit,
  className,
  compact = false,
}: {
  expanded?: boolean;
  compact?: boolean;
  controllerRef: RefObject<EditorController | null>;
  onExit?: () => void;
  className?: string;
}) {
  const active = useEditorActiveState(controllerRef);
  return (
    <div className={cn("flex shrink-0 items-center", className)} role="group" aria-label="文字与段落格式">
      <CommandMenu
        label="段落"
        icon={AlignLeftIcon}
        items={PARAGRAPH_ITEMS}
        controller={controllerRef.current?.formatting}
        active={active}
        onReturnFocus={() => controllerRef.current?.focus()}
        compact={compact}
      />
      <CommandMenu
        label="列表"
        icon={ListIcon}
        items={LIST_ITEMS}
        controller={controllerRef.current?.formatting}
        active={active}
        onReturnFocus={() => controllerRef.current?.focus()}
        compact={compact}
      />
      <CommandMenu
        label="文字"
        icon={TypeIcon}
        items={TEXT_ITEMS}
        controller={controllerRef.current?.formatting}
        active={active}
        onReturnFocus={() => controllerRef.current?.focus()}
        compact={compact}
      />
      {onExit && (
        <button type="button" className={cn(TOOL_TRIGGER, "ml-auto")} onClick={onExit} aria-label="退出专注模式" title="退出专注模式">
          <Minimize2Icon className="size-4" />
        </button>
      )}
    </div>
  );
}
