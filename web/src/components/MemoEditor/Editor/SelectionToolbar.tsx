import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  BoldIcon,
  CodeIcon,
  EraserIcon,
  HighlighterIcon,
  ItalicIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PanelTopCloseIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from "lucide-react";
import { useState } from "react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { isCommandActive } from "../formatting/commands";
import { CommandMenu, TOOL_TRIGGER } from "../Toolbar/CommandMenu";
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
  const commands = [
    { id: "bold", label: "加粗", icon: BoldIcon },
    { id: "italic", label: "斜体", icon: ItalicIcon },
    { id: "underline", label: "下划线", icon: UnderlineIcon },
    { id: "highlight", label: "高亮", icon: HighlighterIcon },
  ] as const;
  return (
    <>
      <BubbleMenu
        editor={editor}
        options={{ placement: "top", offset: 8, flip: { padding: 8 }, shift: { padding: 8 } }}
        className="z-50 flex max-w-[calc(100vw-16px)] rounded-lg border bg-popover p-1 shadow-md"
        role="toolbar"
        aria-label="选中文字格式"
      >
        {commands.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={isCommandActive(state.active, id)}
            className={cn(TOOL_TRIGGER, isCommandActive(state.active, id) && "bg-accent text-accent-foreground")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => controller.run(id)}
          >
            <Icon className="size-4" />
          </button>
        ))}
        <button
          type="button"
          title="链接"
          aria-label="链接"
          aria-pressed={state.active.link}
          className={cn(TOOL_TRIGGER, state.active.link && "bg-accent")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            controller.captureSelection?.();
            setLinkOpen(true);
          }}
        >
          <LinkIcon className="size-4" />
        </button>
        <CommandMenu
          onReturnFocus={() => editor.commands.focus()}
          label="更多文字格式"
          icon={MoreHorizontalIcon}
          compact
          controller={controller}
          active={state.active}
          items={[
            { id: "strikethrough", label: "删除线", icon: StrikethroughIcon },
            { id: "code", label: "行内代码", icon: CodeIcon },
            { id: "clearFormatting", label: "清除文字格式", icon: EraserIcon },
          ]}
        >
          {state.hasDetails && (
            <DropdownMenuItem
              className="min-h-11"
              onClick={() => {
                controller.restoreSelection?.();
                controller.run("convertDetails");
              }}
            >
              <PanelTopCloseIcon className="size-4" />
              转换为折叠区
            </DropdownMenuItem>
          )}
        </CommandMenu>
      </BubbleMenu>
      <LinkEditorDialog onReturnFocus={() => editor.commands.focus()} open={linkOpen} onOpenChange={setLinkOpen} controller={controller} />
    </>
  );
}
