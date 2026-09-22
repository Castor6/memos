import { fromMarkdown } from "mdast-util-from-markdown";
import { type DefaultTreeAdapterMap, parseFragment } from "parse5";

type MarkdownNode = ReturnType<typeof fromMarkdown>["children"][number];
type ImageOccurrence = { url: string; start: number; end: number; render: (url: string) => string };

// Encode delimiters rather than escaping them: the resulting URL works in both
// Markdown destinations and the browser, including filenames containing brackets.
function markdownUrl(url: string): string {
  return url.replace(/[\s<>\\()]/g, (character) => encodeURIComponent(character).replace(/\(/g, "%28").replace(/\)/g, "%29"));
}

function labelEnd(source: string): number {
  let depth = 1;
  for (let index = 2; index < source.length; index++) {
    if (source[index] === "\\") index++;
    else if (source[index] === "[") depth++;
    else if (source[index] === "]" && --depth === 0) return index;
  }
  return -1;
}

function htmlImages(html: string, original: string, offset: number): ImageOccurrence[] {
  // mdast removes blockquote/list prefixes from HTML node values. Map parser
  // locations back to the original source so multiline quoted HTML stays intact.
  const lines: { parsed: number; original: number }[] = [];
  let parsedOffset = 0;
  let originalOffset = 0;
  for (const line of html.split("\n")) {
    const found = original.indexOf(line, originalOffset);
    lines.push({ parsed: parsedOffset, original: found < 0 ? originalOffset : found });
    parsedOffset += line.length + 1;
    originalOffset = (found < 0 ? originalOffset : found) + line.length + 1;
  }
  const sourceOffset = (position: number): number => {
    let line = lines[0];
    for (const candidate of lines) {
      if (candidate.parsed > position) break;
      line = candidate;
    }
    return offset + position + (line ? line.original - line.parsed : 0);
  };
  const images: ImageOccurrence[] = [];
  const visit = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node && node.tagName === "img") {
      const source = node.attrs.find((attribute) => attribute.name === "src");
      const location = node.sourceCodeLocation?.attrs?.src;
      if (source && location) {
        images.push({
          url: source.value,
          start: sourceOffset(location.startOffset),
          end: sourceOffset(location.endOffset),
          render: (url) => `src="${url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`,
        });
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(parseFragment(html, { sourceCodeLocationInfo: true }));
  return images;
}

function imageOccurrences(content: string): ImageOccurrence[] {
  const tree = fromMarkdown(content);
  const definitions = new Map<string, { url: string; title?: string | null }>();
  const visitAll = (node: MarkdownNode | typeof tree, visitor: (node: MarkdownNode | typeof tree) => void): void => {
    visitor(node);
    if ("children" in node) {
      for (const child of node.children) visitAll(child as MarkdownNode, visitor);
    }
  };
  visitAll(tree, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
  });
  const images: ImageOccurrence[] = [];
  visitAll(tree, (node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === "html") {
      images.push(...htmlImages(node.value, content.slice(start, end), start));
      return;
    }
    if (node.type !== "image" && node.type !== "imageReference") return;
    const source = node.type === "image" ? node : definitions.get(node.identifier);
    if (!source) return;
    const raw = content.slice(start, end);
    const close = labelEnd(raw);
    if (close < 0) return;
    if (node.type === "imageReference") {
      // A definition can also be used by ordinary links. Replace only the image
      // occurrence, leaving that shared definition and its other users intact.
      const title = source.title == null ? "" : ` "${source.title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      images.push({ url: source.url, start, end, render: (url) => `${raw.slice(0, close + 1)}(<${markdownUrl(url)}>${title})` });
      return;
    }
    let destinationStart = close + 2;
    while (/\s/.test(raw[destinationStart] ?? "")) destinationStart++;
    const angled = raw[destinationStart] === "<";
    if (angled) destinationStart++;
    let destinationEnd = destinationStart;
    let depth = 0;
    for (; destinationEnd < raw.length; destinationEnd++) {
      const character = raw[destinationEnd];
      if (character === "\\") destinationEnd++;
      else if (angled ? character === ">" : /\s/.test(character ?? "") || (character === ")" && depth === 0)) break;
      else if (!angled && character === "(") depth++;
      else if (!angled && character === ")") depth--;
    }
    images.push({
      url: source.url,
      start: start + destinationStart,
      end: start + destinationEnd,
      render: markdownUrl,
    });
  });
  return images.sort((left, right) => left.start - right.start);
}

/** Return actual image sources in document order, without duplicates. */
export function markdownImageUrls(content: string): string[] {
  return [...new Set(imageOccurrences(content).map((image) => image.url))];
}

/** Preview the saved size, not the temporary base64/CDN sources that uploads replace. */
export function estimatedArchivedBytes(content: string): number {
  const replacements = new Map(
    markdownImageUrls(content)
      .filter((source) => /^(https:|data:image\/)/i.test(source))
      .map((source) => [source, `/file/attachments/${"x".repeat(36)}/clip-00000000.webp`] as const),
  );
  return new TextEncoder().encode(replaceMarkdownImages(content, replacements)).byteLength;
}

/** Replace image destinations without rewriting surrounding Markdown or links. */
export function replaceMarkdownImages(content: string, replacements: ReadonlyMap<string, string>): string {
  if (replacements.size === 0) return content;
  let result = content;
  for (const image of imageOccurrences(content).reverse()) {
    const replacement = replacements.get(image.url);
    if (replacement !== undefined) result = result.slice(0, image.start) + image.render(replacement) + result.slice(image.end);
  }
  return result;
}
