import { type Editor, type JSONContent, Node } from "@tiptap/core";
import { fromMarkdown } from "mdast-util-from-markdown";
import { detailsNodeView } from "./details-node-view";
import { prepareMarkdown } from "./preserved-content";

export const DETAILS_LANGUAGE = "memos-editable-details";

/** Convert only HTML structures whose formatting can be represented without loss. */
function normalizeHTML(source: string): string | null {
  const protectedParts: string[] = [];
  let placeholder = "MEMOSCODEPLACEHOLDER";
  while (source.includes(placeholder)) placeholder += "X";
  const replacements: Array<{ start: number; end: number }> = [];
  const collect = (node: { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: unknown[] }) => {
    if (
      (node.type === "code" || node.type === "inlineCode") &&
      node.position?.start.offset !== undefined &&
      node.position.end.offset !== undefined
    )
      replacements.push({ start: node.position.start.offset, end: node.position.end.offset });
    node.children?.forEach((child) => collect(child as typeof node));
  };
  collect(fromMarkdown(source));
  for (const { start, end } of replacements.reverse()) {
    const index = protectedParts.push(source.slice(start, end)) - 1;
    source = source.slice(0, start) + `${placeholder}${index}END` + source.slice(end);
  }
  const restore = (value: string) =>
    value.replace(new RegExp(`${placeholder}(\\d+)END`, "g"), (_match, index) => protectedParts[Number(index)]);
  if (/<!--|<!doctype|<\/?(?:html|head|body)\b/i.test(source)) return null;
  if (!/<\/?[a-z][^>]*>/i.test(source)) return restore(source);
  if (!/<\/?[a-z][^>]*>/i.test(source.replace(/<\/?u>/g, ""))) return restore(source);
  const document = new DOMParser().parseFromString(source, "text/html");
  let supported = document.head.childNodes.length === 0 && !/<!--|<!doctype|<\/?(?:html|head|body)\b/i.test(source);
  const render = (node: globalThis.Node): string => {
    if (node.nodeType === 3) {
      const text = node.textContent || "";
      return node.parentElement === document.body ? text : text.replace(/[\\`*_[\]<>]/g, "\\$&");
    }
    if (!(node instanceof Element)) {
      supported = false;
      return "";
    }
    const tag = node.tagName.toLowerCase();
    const allowedAttributes: Record<string, string[]> = {
      a: ["href"],
      input: ["type", "checked", "disabled"],
      ol: ["start"],
      ul: ["class"],
      li: ["class"],
    };
    if ([...node.attributes].some((attr) => !allowedAttributes[tag]?.includes(attr.name))) supported = false;
    if (node.hasAttribute("class") && !["contains-task-list", "task-list-item"].includes(node.className)) supported = false;
    const value = [...node.childNodes].map(render).join("");
    switch (tag) {
      case "p":
      case "div":
        return `\n\n${value}\n\n`;
      case "br":
        return "\n";
      case "strong":
      case "b":
        return `**${value}**`;
      case "em":
      case "i":
        return `*${value}*`;
      case "s":
      case "del":
        return `~~${value}~~`;
      case "u":
        return `<u>${value}</u>`;
      case "mark":
        return `==${value}==`;
      case "a": {
        const href = node.getAttribute("href") || "";
        if (!/^(https?:|mailto:|\/|#)/i.test(href) || /[\s()]/.test(href)) supported = false;
        return `[${value}](${href})`;
      }
      case "input":
        if (node.getAttribute("type") !== "checkbox") supported = false;
        return node.hasAttribute("checked") ? "[x] " : "[ ] ";
      case "ul":
      case "ol":
        return `\n\n${[...node.children]
          .map((child, index) => {
            if (child.tagName !== "LI") supported = false;
            const prefix = tag === "ol" ? `${Number(node.getAttribute("start") || 1) + index}. ` : "- ";
            return prefix + render(child).trim().replace(/\n/g, "\n  ");
          })
          .join("\n")}\n\n`;
      case "li":
        return value;
      case "pre": {
        const text = node.textContent || "";
        const fence = "`".repeat(Math.max(3, ...(text.match(/`+/g) || []).map((run) => run.length + 1)));
        return `\n\n${fence}\n${text}\n${fence}\n\n`;
      }
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return `\n\n${"#".repeat(Number(tag[1]))} ${value}\n\n`;
      case "code":
        return `\`${value}\``;
      case "blockquote":
        return `\n\n${value
          .trim()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n\n`;
      default:
        supported = false;
        return value;
    }
  };
  const value = [...document.body.childNodes].map(render).join("").trim();
  return supported ? restore(value) : null;
}

/** Read a complete, supported folding block without changing unsupported source. */
export function parseDetailsSource(source: string): { title: string; body: string } | null {
  const match =
    /^\s*<details(?:\s+open(?:=(?:""|"open"|'open'))?)?\s*>\s*<summary\s*>([\s\S]*?)<\/summary\s*>([\s\S]*?)<\/details\s*>\s*$/i.exec(
      source,
    );
  if (!match || !parseSummary(match[1].trim())) return null;
  const title = match[1].trim();
  const body = normalizeHTML(match[2]);
  if (body === null) return null;
  return { title, body };
}

export const detailsFence = (source: string): string => `\`\`\`${DETAILS_LANGUAGE}\n${encodeURIComponent(source)}\n\`\`\``;

function parseSummary(source: string): JSONContent[] | null {
  const document = new DOMParser().parseFromString(source, "text/html");
  let supported = document.head.childNodes.length === 0 && !/<!--|<!doctype|<\/?(?:html|head|body)\b/i.test(source);
  const marks: Record<string, string> = {
    strong: "bold",
    b: "bold",
    em: "italic",
    i: "italic",
    s: "strike",
    del: "strike",
    u: "underline",
    code: "code",
    mark: "highlight",
  };
  const read = (node: globalThis.Node, inherited: NonNullable<JSONContent["marks"]> = []): JSONContent[] => {
    if (node.nodeType === 3)
      return node.textContent ? [{ type: "text", text: node.textContent, ...(inherited.length ? { marks: inherited } : {}) }] : [];
    if (!(node instanceof Element)) {
      supported = false;
      return [];
    }
    const tag = node.tagName.toLowerCase();
    if ([...node.attributes].some((attr) => !(tag === "a" && attr.name === "href"))) supported = false;
    if (tag === "br") return [{ type: "hardBreak" }];
    let next = inherited;
    if (marks[tag]) next = [...inherited, { type: marks[tag] }];
    else if (tag === "a") {
      const href = node.getAttribute("href") || "";
      if (!/^(https?:|mailto:|\/|#)/i.test(href)) supported = false;
      next = [...inherited, { type: "link", attrs: { href } }];
    } else supported = false;
    return [...node.childNodes].flatMap((child) => read(child, next));
  };
  const content = [...document.body.childNodes].flatMap((node) => read(node));
  return supported ? content : null;
}

const escapeHTML = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function summaryHTML(node: JSONContent): string {
  if (node.type === "hardBreak") return "<br>";
  let value = node.text ? escapeHTML(node.text) : (node.content || []).map(summaryHTML).join("");
  const tags: Record<string, string> = { bold: "strong", italic: "em", strike: "del", underline: "u", highlight: "mark", code: "code" };
  for (const mark of node.marks || []) {
    if (mark.type === "link") value = `<a href="${escapeHTML(String(mark.attrs?.href || ""))}">${value}</a>`;
    else if (tags[mark.type]) value = `<${tags[mark.type]}>${value}</${tags[mark.type]}>`;
  }
  return value;
}

export const DetailsSummary = Node.create({
  name: "detailsSummary",
  content: "inline*",
  defining: true,
  parseHTML: () => [{ tag: "summary" }],
  renderHTML: () => ["summary", { "data-placeholder": "折叠标题" }, 0],
  renderMarkdown: (node, helpers) => helpers.renderChildren(node),
});

export const DetailsBody = Node.create({
  name: "detailsBody",
  content: "block+",
  defining: true,
  parseHTML: () => [{ tag: "div[data-details-body]" }],
  renderHTML: () => ["div", { "data-details-body": "true" }, 0],
  renderMarkdown: (node, helpers) => helpers.renderChildren(node, "\n\n"),
});

export const Details = Node.create({
  name: "details",
  group: "block",
  content: "detailsSummary detailsBody",
  defining: true,
  isolating: true,
  parseHTML: () => [{ tag: "details" }],
  renderHTML: () => ["details", { open: "", class: "editable-details" }, 0],
  addNodeView: () => detailsNodeView,
  markdownTokenName: "editableDetails",
  markdownTokenizer: {
    name: "editableDetails",
    level: "block",
    start: (source: string) => source.indexOf(`\`\`\`${DETAILS_LANGUAGE}`),
    tokenize(source, _tokens, helpers) {
      const match = /^```memos-editable-details\n([^\n]*)\n```/.exec(source);
      if (!match) return;
      let decoded: string;
      try {
        decoded = decodeURIComponent(match[1]);
      } catch {
        return;
      }
      const parsed = parseDetailsSource(decoded);
      if (!parsed) return;
      return {
        type: "editableDetails",
        raw: match[0],
        titleContent: parseSummary(parsed.title),
        tokens: helpers.blockTokens(prepareMarkdown(parsed.body)),
      };
    },
  },
  parseMarkdown: (token, helpers) => {
    const body = helpers.parseChildren(token.tokens || []);
    return helpers.createNode("details", {}, [
      helpers.createNode("detailsSummary", {}, token.titleContent || []),
      helpers.createNode("detailsBody", {}, body.length ? body : [{ type: "paragraph" }]),
    ]);
  },
  renderMarkdown: (node, helpers) => {
    const [title, body] = node.content || [];
    return `<details>\n<summary>${title ? summaryHTML(title) : ""}</summary>\n\n${body ? helpers.renderChildren(body, "\n\n") : ""}\n\n</details>`;
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { $from } = this.editor.state.selection;
        if ($from.parent.type.name !== "detailsSummary") return false;
        return this.editor.commands.setTextSelection($from.after() + 2);
      },
      ArrowDown: () => exitDetails(this.editor),
    };
  },
});

/** Move past a folding block when the caret reaches its final text position. */
export function exitDetails(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parentOffset !== $from.parent.content.size) return false;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name !== "details") continue;
    for (let childDepth = $from.depth - 1; childDepth >= depth; childDepth--)
      if ($from.index(childDepth) !== $from.node(childDepth).childCount - 1) return false;
    const after = $from.after(depth);
    const chain = editor.chain();
    if (editor.state.doc.nodeAt(after)?.type.name !== "paragraph") chain.insertContentAt(after, { type: "paragraph" });
    return chain.setTextSelection(after + 1).run();
  }
  return false;
}

/** Insert a folding block and keep a paragraph available after it. */
export function insertDetails(editor: Editor): boolean {
  const details: JSONContent = {
    type: "details",
    content: [{ type: "detailsSummary" }, { type: "detailsBody", content: [{ type: "paragraph" }] }],
  };
  const { $from } = editor.state.selection;
  // Insert beside the enclosing container to preserve list ownership and avoid nested folds.
  const besideContainer = $from.depth > 1 || $from.parent.type.spec.code;
  const from = besideContainer ? $from.after(1) : editor.state.selection.from;
  const chain = editor.chain().focus();
  const content = [details, { type: "paragraph" }];
  const inserted = besideContainer ? chain.insertContentAt(from, content).run() : chain.insertContent(content).run();
  if (!inserted) return false;
  let titlePosition: number | undefined;
  editor.state.doc.descendants((node, pos) => {
    if (titlePosition === undefined && node.type.name === "details" && pos >= from - 1) titlePosition = pos + 2;
  });
  if (titlePosition !== undefined) editor.commands.setTextSelection(titlePosition);
  return true;
}

function selectedSource(editor: Editor): string {
  const { from, to } = editor.state.selection;
  return editor.state.doc.textBetween(from, to, "\n");
}

export const canConvertSelectionToDetails = (editor: Editor): boolean =>
  editor.state.selection.$from.depth <= 1 && editor.state.selection.$to.depth <= 1 && parseDetailsSource(selectedSource(editor)) !== null;

export function convertSelectionToDetails(editor: Editor): boolean {
  const source = selectedSource(editor);
  if (!canConvertSelectionToDetails(editor)) return false;
  return editor.chain().focus().insertContent(detailsFence(source), { contentType: "markdown" }).run();
}
