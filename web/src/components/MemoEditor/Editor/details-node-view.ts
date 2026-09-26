import type { NodeViewRenderer } from "@tiptap/core";
import { revealFoldHeading } from "@/components/Details/scroll";
import "@/components/Details/details.css";

/** Keep folding state outside the document, so toggles never modify saved content or undo history. */
export const detailsNodeView: NodeViewRenderer = ({ editor, node: initialNode, getPos }) => {
  let node = initialNode;
  let expanded = true;
  const dom = document.createElement("div");
  dom.className = "memo-details editable-details";
  const contentDOM = document.createElement("div");
  contentDOM.className = "memo-details-content";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "memo-details-toggle";
  toggle.contentEditable = "false";
  const footer = document.createElement("div");
  footer.className = "memo-details-footer";
  footer.contentEditable = "false";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "memo-details-close";
  close.textContent = "收起";
  close.setAttribute("aria-label", "收起折叠区");
  footer.append(close);
  dom.append(toggle, contentDOM, footer);

  const paint = () => {
    dom.dataset.expanded = String(expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-label", expanded ? "收起折叠区" : "展开折叠区");
    toggle.title = expanded ? "收起折叠区" : "展开折叠区";
  };
  const selectionInBody = () => {
    const pos = getPos();
    if (pos === undefined) return false;
    const { from, to } = editor.state.selection;
    const bodyStart = pos + 1 + node.child(0).nodeSize;
    return from < pos + node.nodeSize - 1 && to > bodyStart;
  };
  const setExpanded = (next: boolean) => {
    // Move a caret/selection out of content about to be hidden, without a document edit.
    if (!next && editor.isEditable && selectionInBody()) {
      const pos = getPos();
      if (pos !== undefined) editor.commands.setTextSelection(pos + 2);
    }
    expanded = next;
    paint();
    if (!next) {
      toggle.focus({ preventScroll: true });
      revealFoldHeading(toggle);
    }
  };
  toggle.onmousedown = close.onmousedown = (event) => event.preventDefault();
  toggle.onclick = () => setExpanded(!expanded);
  close.onclick = () => setExpanded(false);
  const onSelectionUpdate = () => {
    // Keyboard navigation, search and restored selections may enter a hidden body.
    if (!expanded && selectionInBody()) {
      expanded = true;
      paint();
    }
  };
  editor.on("selectionUpdate", onSelectionUpdate);
  paint();
  return {
    dom,
    contentDOM,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      return true;
    },
    stopEvent: (event) => toggle.contains(event.target as globalThis.Node) || footer.contains(event.target as globalThis.Node),
    ignoreMutation: (mutation) => mutation.type !== "selection" && !contentDOM.contains(mutation.target),
    destroy: () => editor.off("selectionUpdate", onSelectionUpdate),
  };
};
