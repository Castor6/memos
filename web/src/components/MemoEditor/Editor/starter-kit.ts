import StarterKit from "@tiptap/starter-kit";

// The default paragraph serializer omits the first empty paragraph in a run.
// Emit its supported marker for every empty paragraph so reading and editing
// retain the same blank lines, including at the beginning and end of a memo.
export const MemoStarterKit = StarterKit.extend({
  addExtensions() {
    return (this.parent?.() ?? []).map((extension) =>
      extension.name === "paragraph"
        ? extension.extend({
            renderMarkdown: (node, helpers, context) => {
              if (node.content?.length) return helpers.renderChildren(node.content);
              // List items parse their first paragraph inline, so an entity
              // there would become text. Keep the existing empty item syntax.
              if (context.index === 0 && (context.parentType === "listItem" || context.parentType === "taskItem")) return "";
              return "&nbsp;";
            },
          })
        : extension,
    );
  },
});
