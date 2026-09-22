import { describe, expect, it } from "vitest";
import { markdownImageUrls, replaceMarkdownImages } from "../markdown-images";

describe("Markdown image destinations", () => {
  it("collects only images, in first occurrence order, without downloading or resolving relative URLs", () => {
    const content = `Text https://a.test/a.png [link](https://a.test/link.png)
![one](https://a.test/a.png "Title") ![two](../b.png) ![again](https://a.test/a.png)
![data](data:image/png;base64,YQ==)
\`![code](https://a.test/code.png)\`

\`\`\`md
![code](https://a.test/fenced.png)
<img src="https://a.test/fenced-html.png">
\`\`\`

    ![code](https://a.test/indented.png)`;
    expect(markdownImageUrls(content)).toEqual(["https://a.test/a.png", "../b.png", "data:image/png;base64,YQ=="]);
    expect(replaceMarkdownImages(content, new Map([["https://a.test/a.png", "/file/local.png"]]))).toBe(
      content
        .replace('![one](https://a.test/a.png "Title")', '![one](/file/local.png "Title")')
        .replace("![again](https://a.test/a.png)", "![again](/file/local.png)"),
    );
  });

  it("handles escaped and nested parentheses, angle destinations and nested alt brackets", () => {
    const content = String.raw`![a [nested] b](../a(b).png 'title') ![escaped\] alt](../c\(d\).png) ![space](<../e f.png> "kept")`;
    expect(markdownImageUrls(content)).toEqual(["../a(b).png", "../c(d).png", "../e f.png"]);
    const result = replaceMarkdownImages(
      content,
      new Map([
        ["../a(b).png", "/file/a(b).png"],
        ["../c(d).png", "/file/c.png"],
        ["../e f.png", "/file/e f.png"],
      ]),
    );
    expect(result).toBe(
      String.raw`![a [nested] b](/file/a%28b%29.png 'title') ![escaped\] alt](/file/c.png) ![space](</file/e%20f.png> "kept")`,
    );
  });

  it("replaces reference images without changing ordinary links sharing a definition", () => {
    const content = `![one][PHOTO] [ordinary link][photo] ![photo][] ![photo]

[photo]: <https://a.test/a.png> 'Original title'
[photo]: https://ignored.test/second.png`;
    expect(markdownImageUrls(content)).toEqual(["https://a.test/a.png"]);
    const result = replaceMarkdownImages(content, new Map([["https://a.test/a.png", "/file/image.png"]]));
    expect(
      result,
    ).toBe(`![one](</file/image.png> "Original title") [ordinary link][photo] ![photo](</file/image.png> "Original title") ![photo](</file/image.png> "Original title")

[photo]: <https://a.test/a.png> 'Original title'
[photo]: https://ignored.test/second.png`);
  });

  it("handles HTML img inside details and inline HTML, preserving unrelated attributes and HTML", () => {
    const content = `<details><summary>More</summary><p>Before</p><IMG alt='a' SRC='https://a.test/a.png?x=1&amp;y=2' title="title"><p>After</p></details>

Inline <img src=b.png width="20"> and <a href="../b.png">link</a>.
<!-- <img src="comment.png"> -->
<script>"<img src='script.png'>"</script>`;
    expect(markdownImageUrls(content)).toEqual(["https://a.test/a.png?x=1&y=2", "b.png"]);
    expect(
      replaceMarkdownImages(
        content,
        new Map([
          ["https://a.test/a.png?x=1&y=2", '/file/a.png?x=1&y="2"'],
          ["b.png", "/file/b.png"],
        ]),
      ),
    ).toBe(
      content
        .replace("SRC='https://a.test/a.png?x=1&amp;y=2'", 'src="/file/a.png?x=1&amp;y=&quot;2&quot;"')
        .replace("src=b.png", 'src="/file/b.png"'),
    );
  });

  it("keeps blockquote prefixes when HTML spans several lines", () => {
    const content = '> <details>\n> <img alt="a"\n> src="https://a.test/a.png">\n> </details>';
    expect(markdownImageUrls(content)).toEqual(["https://a.test/a.png"]);
    expect(replaceMarkdownImages(content, new Map([["https://a.test/a.png", "/file/a.png"]]))).toBe(
      content.replace("https://a.test/a.png", "/file/a.png"),
    );
  });

  it("preserves failed sources, undefined references and empty replacement maps exactly", () => {
    const content = `![empty]() ![missing][unknown] ![failed](https://bad.test/a.png) ![ok](https://ok.test/a.png)`;
    expect(replaceMarkdownImages(content, new Map())).toBe(content);
    expect(replaceMarkdownImages(content, new Map([["https://ok.test/a.png", "/file/ok.png"]]))).toBe(
      content.replace("https://ok.test/a.png", "/file/ok.png"),
    );
    expect(markdownImageUrls(content)).toEqual(["", "https://bad.test/a.png", "https://ok.test/a.png"]);
  });
});
