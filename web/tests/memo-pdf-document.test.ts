import { describe, expect, it } from "vitest";
import { createMemoPdfDefinition } from "@/components/MemoActionMenu/memoPdfDocument";
import { createMemoPrintDocument } from "@/components/MemoActionMenu/memoPrintDocument";

describe("downloadable PDF document", () => {
  it("keeps Chinese text, task states, tables and links as document content", async () => {
    const signal = new AbortController().signal;
    const html = await createMemoPrintDocument(
      "# 中文标题\n\n**重点**和正文\n\n- [ ] 未完成\n- [x] 已完成\n\n| 项目 | 结果 |\n| --- | --- |\n| 测试 | 通过 |\n\n[附件](https://example.com/file.pdf)",
      "中文导出",
      signal,
    );
    const doc = await createMemoPdfDefinition(html, signal);
    const serialized = JSON.stringify(doc.content);
    for (const value of ["中文标题", "重点", "□", "✓", "未完成", "已完成", "测试", "https://example.com/file.pdf"])
      expect(serialized).toContain(value);
    const table = (doc.content as Array<{ table?: object }>).find((node) => node.table)?.table;
    expect(table).toMatchObject({ widths: ["*", "*"], headerRows: 1 });
    expect(serialized).toContain('"bold":true');
    expect(doc.defaultStyle?.font).toBe("NotoSansSC");
    expect(doc.info?.title).toBe("中文导出");
  });

  it("does not silently export images that were not embedded", async () => {
    await expect(
      createMemoPdfDefinition('<main><img src="https://example.com/missing.png"></main>', new AbortController().signal),
    ).rejects.toThrow("图片尚未准备完成");
  });
});
