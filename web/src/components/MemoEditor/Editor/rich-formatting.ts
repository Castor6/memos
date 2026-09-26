import type { Editor } from "@tiptap/core";
import type { Mark } from "@tiptap/pm/model";
import type { SelectionBookmark, Transaction } from "@tiptap/pm/state";
import { toast } from "react-hot-toast";
import { type EditorCommandId, EMPTY_ACTIVE_FORMATS, toToolbarHeadingLevel } from "../formatting/commands";
import type { FormattingController } from "../types/editorController";
import { canConvertSelectionToDetails, convertSelectionToDetails, insertDetails } from "./editable-details";

const TEXT_MARKS = ["bold", "italic", "underline", "strike", "highlight", "code"];
const BLOCK_COMMANDS = new Set<EditorCommandId>([
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "taskList",
  "insertDetails",
]);

/** Share rich-text commands and menu selection handling across editor surfaces. */
export function createRichFormattingController(editor: Editor, isReadOnly: () => boolean): FormattingController {
  let saved: { bookmark: SelectionBookmark; marks: readonly Mark[] | null } | undefined;
  const editable = () => !isReadOnly() && !editor.isDestroyed && editor.isEditable;
  const mapSelection = ({ transaction }: { transaction: Transaction }) => {
    if (saved && transaction.docChanged) saved.bookmark = saved.bookmark.map(transaction.mapping);
  };
  const restoreSelection = () => {
    const snapshot = saved;
    saved = undefined;
    editor.off("transaction", mapSelection);
    if (!snapshot || !editable()) return;
    const selection = snapshot.bookmark.resolve(editor.state.doc);
    editor.view.dispatch(editor.state.tr.setSelection(selection).setStoredMarks(snapshot.marks));
  };
  const canRun = (command: EditorCommandId): boolean => {
    if (!editable()) return false;
    if (BLOCK_COMMANDS.has(command) && editor.isActive("detailsSummary")) return false;
    const can = editor.can();
    switch (command) {
      case "bold":
        return can.toggleBold();
      case "italic":
        return can.toggleItalic();
      case "underline":
        return can.toggleUnderline();
      case "strikethrough":
        return can.toggleStrike();
      case "highlight":
        return can.toggleHighlight();
      case "code":
        return can.toggleCode();
      case "blockquote":
        return can.toggleBlockquote();
      case "codeBlock":
        return can.toggleCodeBlock();
      case "bulletList":
        return can.toggleBulletList();
      case "orderedList":
        return can.toggleOrderedList();
      case "taskList":
        return can.toggleTaskList();
      case "paragraph":
        return can.setParagraph();
      case "heading1":
        return can.toggleHeading({ level: 1 });
      case "heading2":
        return can.toggleHeading({ level: 2 });
      case "heading3":
        return can.toggleHeading({ level: 3 });
      case "undo":
        return can.undo();
      case "redo":
        return can.redo();
      case "link":
        return !editor.isActive("codeBlock") && !editor.isActive("code");
      case "convertDetails":
        return canConvertSelectionToDetails(editor);
      default:
        return true;
    }
  };
  return {
    captureSelection: () => {
      if (!editable()) return;
      saved = { bookmark: editor.state.selection.getBookmark(), marks: editor.state.storedMarks };
      editor.off("transaction", mapSelection);
      editor.on("transaction", mapSelection);
    },
    restoreSelection,
    canRun,
    getSelectedText: () => {
      const { from, to } = editor.state.selection;
      return editor.state.doc.textBetween(from, to, "\n");
    },
    run: (command, context) => {
      if (!editable()) return;
      restoreSelection();
      if (command === "convertDetails") {
        if (!convertSelectionToDetails(editor)) toast.error("请选择完整且受支持的 <details>…</details> 折叠语法，原文字已保留。");
        return;
      }
      if (!canRun(command)) return;
      const chain = editor.chain().focus();
      switch (command) {
        case "bold":
          chain.toggleBold().run();
          break;
        case "italic":
          chain.toggleItalic().run();
          break;
        case "underline":
          chain.toggleUnderline().run();
          break;
        case "strikethrough":
          chain.toggleStrike().run();
          break;
        case "highlight":
          chain.toggleHighlight().run();
          break;
        case "code":
          chain.toggleCode().run();
          break;
        case "blockquote":
          chain.toggleBlockquote().run();
          break;
        case "codeBlock":
          chain.toggleCodeBlock().run();
          break;
        case "bulletList":
          chain.toggleBulletList().run();
          break;
        case "orderedList":
          chain.toggleOrderedList().run();
          break;
        case "taskList":
          chain.toggleTaskList().run();
          break;
        case "paragraph":
          chain.setParagraph().run();
          break;
        case "heading1":
          chain.toggleHeading({ level: 1 }).run();
          break;
        case "heading2":
          chain.toggleHeading({ level: 2 }).run();
          break;
        case "heading3":
          chain.toggleHeading({ level: 3 }).run();
          break;
        case "undo":
          chain.undo().run();
          break;
        case "redo":
          chain.redo().run();
          break;
        case "insertDetails":
          insertDetails(editor);
          break;
        case "clearFormatting":
          for (const mark of TEXT_MARKS) chain.unsetMark(mark);
          chain.run();
          break;
        case "link":
          if (!context?.url) chain.unsetLink().run();
          else if (/^https?:\/\//i.test(context.url)) {
            if (editor.state.selection.empty && !editor.isActive("link")) {
              chain.insertContent({ type: "text", text: context.url, marks: [{ type: "link", attrs: { href: context.url } }] }).run();
            } else chain.extendMarkRange("link").setLink({ href: context.url }).run();
          }
          break;
      }
    },
    getActiveFormats: () => ({
      ...EMPTY_ACTIVE_FORMATS,
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      underline: editor.isActive("underline"),
      strikethrough: editor.isActive("strike"),
      highlight: editor.isActive("highlight"),
      code: editor.isActive("code"),
      codeBlock: editor.isActive("codeBlock"),
      blockquote: editor.isActive("blockquote"),
      bulletList: editor.isActive("bulletList"),
      orderedList: editor.isActive("orderedList"),
      taskList: editor.isActive("taskList"),
      link: editor.isActive("link"),
      headingLevel: toToolbarHeadingLevel(editor.getAttributes("heading").level),
    }),
    subscribe: (listener) => {
      editor.on("transaction", listener);
      return () => {
        editor.off("transaction", listener);
      };
    },
  };
}
