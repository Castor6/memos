import { describe, expect, it } from "vitest";
import { countMemoWords } from "@/utils/word-count";

describe("countMemoWords", () => {
  it("counts Han characters, English words and numeric runs without punctuation", () => {
    expect(countMemoWords("你好，world! Don't stop 12345。🙂")).toBe(6);
    expect(countMemoWords(" \n\t！？🙂")).toBe(0);
    expect(countMemoWords("hello世界2026")).toBe(4);
  });
  it("counts visible Markdown labels and task text without syntax or tags", () => {
    expect(countMemoWords("# 标题\n\n- [ ] **hello** [世界](https://example.com)\n- [x] done\n\n#工作 #project/a")).toBe(6);
    expect(countMemoWords("hel**lo**")).toBe(1);
    expect(countMemoWords("\\#literal `#code`\n\n```txt\nhello world\n```")).toBe(4);
  });
  it("keeps block boundaries inside quotes and list items", () => {
    expect(countMemoWords("> hello\n>\n> world")).toBe(2);
    expect(countMemoWords("- hello\n\n  world")).toBe(2);
    expect(countMemoWords("> # hello\n> world")).toBe(2);
    expect(countMemoWords("hel**lo**")).toBe(1);
  });
  it("excludes media, attachments and automatic reference previews", () => {
    expect(
      countMemoWords(
        '![描述](/file/attachments/a/pic.png)\n![报告.pdf](/file/attachments/b/report.pdf "memos:file:application/pdf")\n![引用正文](/memos/abc "memos:reference")',
      ),
    ).toBe(0);
    expect(countMemoWords('[链接标题](https://example.com "ignored title")')).toBe(4);
  });
  it("includes the full folded body and summary", () => {
    expect(countMemoWords("<details>\n<summary>摘要</summary>\n\n**正文** hello\n\n</details>")).toBe(5);
    expect(countMemoWords("<details><summary>标题</summary><div>一</div><div>二</div></details>")).toBe(4);
  });
});
