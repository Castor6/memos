export const FILE_TITLE = "memos:file:";
export const REFERENCE_TITLE = "memos:reference";

export function safeMediaURL(value: string): string {
  try {
    const url = new URL(value, window.location.origin);
    return ["http:", "https:", "blob:"].includes(url.protocol) ? value : "";
  } catch {
    return "";
  }
}

export function fileMarkdown(src: string, title: string, label: string): string {
  if (src.startsWith(`${window.location.origin}/`)) src = src.slice(window.location.origin.length);
  const text = label.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ");
  return `![${text}](<${src.replace(/[<>\s]/g, (s) => encodeURIComponent(s))}> "${title.replace(/["\\]/g, "\\$&")}")`;
}
