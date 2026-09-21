import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import htmlToPdfmake from "html-to-pdfmake";
import pdfmake from "pdfmake";

/** Only server-prepared HTML with embedded raster images reaches this renderer. */
export function definition(html, title) {
  const { window } = new JSDOM(html);
  try {
    const main = window.document.body;
    for (const element of main.querySelectorAll("script,style,iframe,object,embed,link")) element.remove();
    for (const checkbox of main.querySelectorAll('input[type="checkbox"]')) {
      checkbox.replaceWith(window.document.createTextNode(checkbox.checked ? "✓ " : "□ "));
    }
    for (const element of main.querySelectorAll("*")) {
      // Never let document content inject pdfmake file paths or document options.
      element.removeAttribute("data-pdfmake");
      element.removeAttribute("style");
    }
    for (const table of main.querySelectorAll("table")) {
      const columns = table.rows[0]?.cells.length || 1;
      table.dataset.pdfmake = JSON.stringify({ widths: Array(columns).fill("*"), headerRows: table.tHead ? 1 : 0 });
    }
    for (const image of main.querySelectorAll("img")) {
      if (!/^data:image\/(png|jpeg);base64,/i.test(image.src)) throw new Error("图片尚未准备完成");
      const columns = image.closest("table")?.rows[0]?.cells.length || 1;
      const width = Math.max(1, Math.min(Number(image.getAttribute("width")) || 487, 487 / columns - (columns > 1 ? 12 : 0)));
      image.removeAttribute("width");
      image.removeAttribute("height");
      image.dataset.pdfmake = JSON.stringify({ fit: [width, 690], margin: [0, 6, 0, 10] });
    }
    return {
      info: { title },
      pageSize: "A4",
      pageMargins: [54, 48, 54, 48],
      defaultStyle: { font: "NotoSansSC", fontSize: 11, lineHeight: 1.35, color: "#171717" },
      content: htmlToPdfmake(main.innerHTML, {
        window,
        removeExtraBlanks: true,
        defaultStyles: {
          h1: { fontSize: 24, bold: true, margin: [0, 12, 0, 12] },
          h2: { fontSize: 19, bold: true, margin: [0, 10, 0, 10] },
          h3: { fontSize: 15, bold: true, margin: [0, 8, 0, 8] },
          p: { margin: [0, 0, 0, 9] },
          a: { color: "#235da8", decoration: "underline" },
          pre: { fontSize: 9, background: "#f5f5f5", margin: [0, 6, 0, 10] },
          code: { fontSize: 9, background: "#f5f5f5" },
          blockquote: { color: "#555555", margin: [12, 0, 0, 10] },
          th: { bold: true, fillColor: "#f5f5f5" },
        },
      }),
      footer: (page, count) => ({ text: `${page} / ${count}`, alignment: "center", fontSize: 9, color: "#666666", margin: [0, 14, 0, 0] }),
    };
  } finally {
    window.close();
  }
}

export async function render(html, title) {
  const regular = fileURLToPath(new URL("./fonts/Regular.otf", import.meta.url));
  const bold = fileURLToPath(new URL("./fonts/Bold.otf", import.meta.url));
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((path) => path === regular || path === bold);
  pdfmake.setFonts({ NotoSansSC: { normal: regular, bold, italics: regular, bolditalics: bold } });
  return pdfmake.createPdf(definition(html, title)).getBuffer();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 48 * 1024 * 1024) throw new Error("导出内容过大");
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    process.stdout.write(await render(input.html, input.title));
  } catch {
    process.stderr.write("PDF 排版失败\n");
    process.exitCode = 1;
  }
}
