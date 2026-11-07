import { Extension } from "@tiptap/core";

export const VisualLineEnd = Extension.create({
  name: "visualLineEnd",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      End: () => {
        const { view } = this.editor;
        if (!this.editor.isEditable || view.composing) return false;

        const selection = view.dom.ownerDocument.getSelection();
        if (!selection?.focusNode || !view.dom.contains(selection.focusNode) || typeof selection.modify !== "function") return false;

        // Native line boundaries respect wrapping and preserve caret affinity at soft breaks.
        // Let ProseMirror observe selectionchange instead of resetting that native caret.
        selection.modify("move", "forward", "lineboundary");
        return true;
      },
    };
  },
});
