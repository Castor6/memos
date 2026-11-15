import { Marked, type marked } from "marked";

const HTTP_URL = /^https?:\/\//i;

/** Whether a bare URL should become a link: only explicit http(s) addresses qualify. */
export const isHttpUrl = (url: string) => HTTP_URL.test(url);

/**
 * Creates the editor's own marked instance. GFM would otherwise autolink `www.` hosts and
 * email addresses, which the editor then saves back as `[text](href)` and rewrites the source.
 */
export function createMemoMarked(): typeof marked {
  const instance = new Marked({
    breaks: true,
    tokenizer: {
      // `false` falls back to marked's default URL tokenizer; `undefined` keeps the text plain.
      url: (src: string) => (isHttpUrl(src) ? false : undefined),
    },
  });
  // @tiptap/markdown types its option as the global `marked`, but only uses the instance API
  // (use, lexer, Lexer, defaults, setOptions), which a `Marked` instance provides.
  return instance as unknown as typeof marked;
}
