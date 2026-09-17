import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { BoldIcon, CodeIcon, HighlighterIcon, ItalicIcon, StrikethroughIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export default function SelectionToolbar({ editor }: { editor: Editor }) {
  const active = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      strike: editor.isActive("strike"),
      code: editor.isActive("code"),
      highlight: editor.isActive("highlight"),
    }),
  });
  const commands = [
    { id: "bold", label: "加粗", icon: BoldIcon, run: () => editor.chain().focus().toggleBold().run() },
    { id: "italic", label: "斜体", icon: ItalicIcon, run: () => editor.chain().focus().toggleItalic().run() },
    { id: "strike", label: "删除线", icon: StrikethroughIcon, run: () => editor.chain().focus().toggleStrike().run() },
    { id: "code", label: "行内代码", icon: CodeIcon, run: () => editor.chain().focus().toggleCode().run() },
    { id: "highlight", label: "高亮", icon: HighlighterIcon, run: () => editor.chain().focus().toggleHighlight().run() },
  ] as const;
  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top", offset: 8 }}
      className="z-50 flex rounded-lg border bg-popover p-1 shadow-md"
      role="toolbar"
      aria-label="选中文字格式"
    >
      {commands.map(({ id, label, icon: Icon, run }) => (
        <button
          key={id}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={active[id]}
          className={cn("rounded p-2 hover:bg-muted", active[id] && "bg-accent")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={run}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </BubbleMenu>
  );
}
