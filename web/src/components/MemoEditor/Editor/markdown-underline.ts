import { Mark } from "@tiptap/core";

/** Use the HTML representation understood by the reading renderer. */
export const MarkdownUnderline = Mark.create({
  name: "underline",
  parseHTML: () => [{ tag: "u" }],
  renderHTML: () => ["u", 0],
  renderMarkdown: (node, helpers) => `<u>${helpers.renderChildren(node)}</u>`,
  parseMarkdown: (token, helpers) => helpers.applyMark("underline", helpers.parseInline(token.tokens || [])),
  markdownTokenizer: {
    name: "underline",
    level: "inline",
    start: (source: string) => source.indexOf("<u>"),
    tokenize(source, _tokens, helpers) {
      const match = /^<u>([\s\S]*?)<\/u>/.exec(source);
      if (match) return { type: "underline", raw: match[0], tokens: helpers.inlineTokens(match[1]) };
    },
  },
  addCommands() {
    return {
      setUnderline:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleUnderline:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetUnderline:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    return { "Mod-u": () => this.editor.commands.toggleMark(this.name) };
  },
});
