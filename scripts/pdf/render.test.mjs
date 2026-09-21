import { test } from "node:test";
import assert from "node:assert/strict";
import { definition, render } from "./render.mjs";

test("Chinese text, tasks, tables, and links survive document conversion", () => {
  const doc = definition('<h1>中文标题</h1><p><b>重点</b>正文</p><ul><li><input type="checkbox">未完成</li><li><input type="checkbox" checked>已完成</li></ul><table><thead><tr><th>项目</th><th>结果</th></tr></thead><tbody><tr><td>测试</td><td>通过</td></tr></tbody></table><p><a href="https://example.com/file.pdf">附件</a></p>', "中文导出");
  const content = JSON.stringify(doc.content);
  for (const value of ["中文标题", "重点", "□", "✓", "未完成", "已完成", "测试", "https://example.com/file.pdf"]) assert.ok(content.includes(value));
  const table = doc.content.find(node => node.table).table;
  assert.deepEqual(table.widths, ["*", "*"]);
  assert.equal(table.headerRows, 1);
});

test("rejects unprepared remote or local images and discards injected options", () => {
  assert.throws(() => definition('<img src="https://example.com/image.png">', "test"), /图片尚未准备完成/);
  assert.throws(() => definition('<img src="/etc/passwd">', "test"), /图片尚未准备完成/);
  const doc = definition('<p data-pdfmake=\'{"image":"/etc/passwd"}\'>安全正文</p>', "test");
  assert.ok(!JSON.stringify(doc).includes("/etc/passwd"));
});

test("generates an actual PDF with server-side fonts", async () => {
  const pdf = await render('<h1>服务器导出</h1><p>中文可复制、完整长文。</p>', "服务端验证");
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 1000);
});
