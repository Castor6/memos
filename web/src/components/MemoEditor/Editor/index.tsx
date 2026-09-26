import { Extension } from "@tiptap/core";
import Highlight from "@tiptap/extension-highlight";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import type { EditorController } from "../types/editorController";
import { Details, DetailsBody, DetailsSummary } from "./editable-details";
import { MarkdownUnderline } from "./markdown-underline";
import { InlineMedia } from "./media";
import { PreservedContent, prepareMarkdown } from "./preserved-content";
import { createRichFormattingController } from "./rich-formatting";
import SelectionToolbar from "./SelectionToolbar";
import "./rich-editor.css";

interface EditorProps {
  className: string;
  initialContent: string;
  placeholder: string;
  onContentChange: (content: string) => void;
  onFiles: (files: File[]) => void;
  onSubmit: () => void;
  isFocusMode?: boolean;
  readOnly?: boolean;
}

const Editor = forwardRef<EditorController, EditorProps>((props, ref) => {
  const { userGeneralSetting } = useAuth();
  const current = useRef({ ...props, enterToSave: userGeneralSetting?.enterToSave ?? false });
  current.current = { ...props, enterToSave: userGeneralSetting?.enterToSave ?? false };
  const lastEmitted = useRef(props.initialContent);
  const editor = useEditor({
    editable: !props.readOnly,
    extensions: [
      StarterKit.configure({
        underline: false,
        trailingNode: false,
        link: { openOnClick: false },
        heading: { levels: [1, 2, 3, 4, 5, 6] },
      }),
      MarkdownUnderline,
      Details,
      DetailsSummary,
      DetailsBody,
      TableKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      Highlight,
      InlineMedia,
      Placeholder.configure({ placeholder: () => current.current.placeholder }),
      PreservedContent,
      Markdown.configure({ markedOptions: { breaks: true } }),
      Extension.create({
        name: "memoSaveKeys",
        priority: 1000,
        addKeyboardShortcuts() {
          const newline = () =>
            this.editor.commands.first(({ commands }) => [
              () => {
                const { $from } = this.editor.state.selection;
                return $from.parent.type.name === "detailsSummary" && commands.setTextSelection($from.after() + 2);
              },
              () => commands.splitListItem("taskItem"),
              () => commands.splitListItem("listItem"),
              () => commands.liftListItem("taskItem"),
              () => commands.liftListItem("listItem"),
              () => commands.newlineInCode(),
              () => commands.splitBlock(),
            ]);
          const mobile = () => window.matchMedia("(pointer: coarse)").matches;
          const modifiedEnter = () => {
            if (this.editor.view.composing) return false;
            if (current.current.enterToSave) return newline();
            current.current.onSubmit();
            return true;
          };
          return {
            Enter: () => {
              if (this.editor.view.composing) return false;
              if (current.current.enterToSave && !mobile()) {
                current.current.onSubmit();
                return true;
              }
              return false;
            },
            "Shift-Enter": () => (this.editor.view.composing ? false : newline()),
            "Ctrl-Enter": modifiedEnter,
            "Cmd-Enter": modifiedEnter,
          };
        },
      }),
    ],
    content: prepareMarkdown(props.initialContent),
    contentType: "markdown",
    editorProps: {
      attributes: { class: "rich-editor", role: "textbox", "aria-multiline": "true", "aria-label": "正文" },
      handlePaste: (_view, event) => {
        if (current.current.readOnly) return true;
        const files = Array.from(event.clipboardData?.files || []);
        if (!files.length) return false;
        current.current.onFiles(files);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (current.current.readOnly) return true;
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files || []);
        if (!files.length) return false;
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (position) editor?.commands.setTextSelection(position.pos);
        current.current.onFiles(files);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      const markdown = editor.getMarkdown();
      lastEmitted.current = markdown;
      current.current.onContentChange(markdown);
    },
  });

  const formatting = useMemo(
    () => (editor ? createRichFormattingController(editor, () => Boolean(current.current.readOnly)) : undefined),
    [editor],
  );

  useEffect(() => {
    // Toggling editability must not emit the old document over a successful reset.
    editor?.setEditable(!props.readOnly, false);
  }, [editor, props.readOnly]);

  useEffect(() => {
    if (editor && props.initialContent !== lastEmitted.current) {
      lastEmitted.current = props.initialContent;
      editor.commands.setContent(prepareMarkdown(props.initialContent), { contentType: "markdown", emitUpdate: false });
    }
  }, [editor, props.initialContent]);

  useEffect(() => {
    editor?.view.dispatch(editor.state.tr);
  }, [editor, props.placeholder]);

  useImperativeHandle(
    ref,
    () => ({
      focus: (position) => {
        if (!current.current.readOnly) editor?.commands.focus(position);
      },
      hasFocus: () => editor?.isFocused ?? false,
      isEmpty: () => editor?.isEmpty ?? true,
      getMarkdown: () => editor?.getMarkdown() ?? "",
      setMarkdown: (text) => {
        editor?.commands.setContent(prepareMarkdown(text), { contentType: "markdown" });
      },
      insertMarkdown: (text) => {
        if (!current.current.readOnly) editor?.chain().focus().insertContent(prepareMarkdown(text), { contentType: "markdown" }).run();
      },
      insertText: (text) => {
        if (current.current.readOnly) return;
        formatting?.restoreSelection?.();
        if (editor) editor.view.dispatch(editor.state.tr.insertText(text));
        editor?.commands.focus();
      },
      insertFile: (src, title, alt) => {
        if (!editor || current.current.readOnly) return;
        formatting?.restoreSelection?.();
        editor.chain().focus().setImage({ src, title, alt }).run();
        // Leave a text caret after the block so continued typing cannot replace it.
        let after = -1;
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === "image" && node.attrs.src === src) after = pos + node.nodeSize;
        });
        if (after >= 0) {
          if (!editor.state.doc.nodeAt(after)?.isTextblock) editor.commands.insertContentAt(after, { type: "paragraph" });
          editor.commands.setTextSelection(after + 1);
        }
      },
      replaceFile: (src, replacement) => {
        if (!editor) return;
        const tr = editor.state.tr;
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === "image" && node.attrs.src === src) {
            if (replacement) tr.setNodeMarkup(tr.mapping.map(pos), undefined, { ...node.attrs, src: replacement });
            else tr.delete(tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize));
          }
        });
        tr.setMeta("addToHistory", false);
        editor.view.dispatch(tr);
      },
      scrollToCursor: () => {
        editor?.commands.scrollIntoView();
      },
      selectAll: () => {
        editor?.commands.selectAll();
      },
      edit: (action) => {
        formatting?.run(action === "clear" ? "clearFormatting" : action);
      },
      formatting,
    }),
    [editor, formatting],
  );

  return (
    <>
      <EditorContent editor={editor} className={cn("w-full min-h-24", props.className, props.isFocusMode && "flex-1")} />
      {editor && formatting && <SelectionToolbar editor={editor} controller={formatting} />}
    </>
  );
});
Editor.displayName = "RichMemoEditor";
export default Editor;
