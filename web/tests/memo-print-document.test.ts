import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoPrintDocument } from "@/components/MemoActionMenu/memoPrintDocument";

afterEach(() => vi.unstubAllGlobals());
describe("PDF print document", () => {
  it("keeps selectable text, tables and tasks and embeds repeated images only once", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["image"], { type: "image/png" }) });
    vi.stubGlobal("fetch", fetchMock);
    const html = await createMemoPrintDocument('# 标题\n\n正文\n\n- [x] 完成\n\n| A | B |\n| --- | --- |\n| 甲 | 乙 |\n\n![一](https://notes.example.com/a.png)\n\n![二](https://notes.example.com/a.png)\n\n[文件](https://notes.example.com/a.pdf)', '标题', new AbortController().signal);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('h1')?.textContent).toBe('标题');
    expect(doc.querySelector('table')).not.toBeNull();
    expect(doc.querySelector('input')?.checked).toBe(true);
    expect(doc.images.length).toBe(2);
    expect([...doc.images].every(image => image.src.startsWith('data:image/png;base64,'))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(doc.querySelector('a')?.href).toBe('https://notes.example.com/a.pdf');
  });
  it("fails visibly rather than silently omitting an inaccessible image", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(createMemoPrintDocument('![图](https://notes.example.com/a.png)', 'test', new AbortController().signal)).rejects.toThrow('图片读取失败');
  });
  it("never puts user HTML or scripts into the executable document", async () => {
    const html = await createMemoPrintDocument('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>', '<script>title</script>', new AbortController().signal);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.querySelector('[onerror]')).toBeNull();
    expect(doc.title).toBe('<script>title</script>');
  });
});
