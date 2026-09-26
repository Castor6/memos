import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { BoldIcon, HighlighterIcon, ItalicIcon, LinkIcon, PanelTopCloseIcon, StrikethroughIcon, UnderlineIcon } from "lucide-react";
import { useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isCommandActive } from "../formatting/commands";
import type { CommandItem } from "../Toolbar/CommandMenu";
import { LinkEditorDialog } from "../Toolbar/LinkEditorDialog";
import type { FormattingController } from "../types/editorController";

export default function SelectionToolbar({ editor, controller }: { editor: Editor; controller: FormattingController }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const state = useEditorState({
    editor,
    selector: () => ({
      active: controller.getActiveFormats(),
      hasDetails: /<\/?(?:details|summary)\b/i.test(controller.getSelectedText?.() ?? ""),
    }),
  });
  const commands: CommandItem[] = [
    { id: "bold", label: "加粗", icon: BoldIcon },
    { id: "italic", label: "斜体", icon: ItalicIcon },
    { id: "underline", label: "下划线", icon: UnderlineIcon },
    { id: "strikethrough", label: "删除线", icon: StrikethroughIcon },
    { id: "highlight", label: "高亮", icon: HighlighterIcon },
    { id: "link", label: "链接", icon: LinkIcon },
    ...(state.hasDetails ? [{ id: "convertDetails" as const, label: "转换为折叠区", icon: PanelTopCloseIcon }] : []),
  ];
  return (
    <>
      <BubbleMenu
        editor={editor}
        options={{ placement: "top", offset: 6, flip: { padding: 8 }, shift: { padding: 8 } }}
        className="z-50 flex w-max max-w-[calc(100vw-16px)] flex-wrap rounded-md border bg-popover p-0.5 shadow-sm"
        role="toolbar"
        aria-label="选中文字格式"
      >
        {commands.map(({ id, label, icon: Icon }) => (
          <Tooltip key={id}>
            <TooltipTrigger
              type="button"
              aria-label={label}
              aria-pressed={id === "clearFormatting" || id === "convertDetails" ? undefined : isCommandActive(state.active, id)}
              disabled={controller.canRun?.(id) === false}
              className={cn(
                "inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
                isCommandActive(state.active, id) && "bg-accent text-accent-foreground",
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (id === "link") {
                  controller.captureSelection?.();
                  setLinkOpen(true);
                } else controller.run(id);
              }}
            >
              <Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={5}>
              {label}
            </TooltipContent>
          </Tooltip>
        ))}
      </BubbleMenu>
      <LinkEditorDialog onReturnFocus={() => editor.commands.focus()} open={linkOpen} onOpenChange={setLinkOpen} controller={controller} />
    </>
  );
}
