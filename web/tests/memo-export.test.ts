import { describe, expect, it } from "vitest";
import { exportMemoMarkdown, memoExportFilename } from "@/lib/memo-export";

const origin = "https://notes.example.com";
describe("Markdown export", () => {
  it("keeps inline file order and converts custom file types to portable links", () => {
    const source = '# 正文\n\n前面\n\n![照片](</file/a.png> "memos:file:image/png")\n\n中间\n\n![录像](</file/b.mp4> "memos:file:video/mp4")\n\n![资料](</file/c.pdf> "memos:file:application/pdf")\n\n后面';
    expect(exportMemoMarkdown(source, origin)).toBe('# 正文\n\n前面\n\n![照片](<https://notes.example.com/file/a.png>)\n\n中间\n\n[录像](<https://notes.example.com/file/b.mp4>)\n\n[资料](<https://notes.example.com/file/c.pdf>)\n\n后面');
  });
  it("preserves code and formatting instead of rewriting source-looking examples", () => {
    const source = '```md\n![file](/file/x "memos:file:video/mp4")\n```\n\n**重点**\n\n- [ ] 任务\n\n`[链接](/x)`';
    expect(exportMemoMarkdown(source, origin)).toBe(source);
  });
  it("handles reference images, linked images, escaped labels and reference cards", () => {
    const result = exportMemoMarkdown('![文件][doc]\n\n[doc]: /file/a.pdf "memos:file:application/pdf"\n\n[![图](/file/x.png)](/memos/abc)\n\n![笔记](/memos/abc "memos:reference")', origin);
    expect(result).toContain('[文件](<https://notes.example.com/file/a.pdf>)');
    expect(result).toContain('[![图](<https://notes.example.com/file/x.png>)](<https://notes.example.com/memos/abc>)');
    expect(result).toContain('[笔记](<https://notes.example.com/memos/abc>)');
    expect(exportMemoMarkdown('![a\\]b](/file/x.png)', origin)).toContain('![a\\]b]');
  });
  it("does not introduce unsafe destinations or append attachments", () => {
    expect(exportMemoMarkdown('[坏链接](javascript:alert)\n\n只有正文', origin)).toBe('[坏链接](<>)\n\n只有正文');
    expect(memoExportFilename('memos/abc', '../测试:/名称', 'md')).toBe('..-测试--名称.md');
  });
});
