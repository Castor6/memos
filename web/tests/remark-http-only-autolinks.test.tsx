import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { remarkHttpOnlyAutolinks } from "@/utils/remark-plugins/remark-http-only-autolinks";

const render = (content: string) =>
  renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm, remarkHttpOnlyAutolinks]}>{content}</ReactMarkdown>);

describe("remarkHttpOnlyAutolinks", () => {
  it("keeps www hosts and email addresses as plain text", () => {
    const html = render("abc=www.samsung.com&sid=1 a@b.com mailto:x@y.z www.example.com/path");
    expect(html).not.toContain("<a");
    expect(html).toContain("abc=www.samsung.com&amp;sid=1 a@b.com mailto:x@y.z www.example.com/path");
  });

  it("still links explicit http(s) addresses and Markdown links", () => {
    const html = render("see https://a.com and [www.x.com](http://www.x.com) and <https://b.com> and [ref][r]\n\n[r]: https://c.com");
    expect(html).toContain('<a href="https://a.com">https://a.com</a>');
    expect(html).toContain('<a href="http://www.x.com">www.x.com</a>');
    expect(html).toContain('<a href="https://b.com">https://b.com</a>');
    expect(html).toContain('<a href="https://c.com">ref</a>');
  });
});
