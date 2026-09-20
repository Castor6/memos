import htmlToPdfmake from "html-to-pdfmake";
import type { TDocumentDefinitions } from "pdfmake/interfaces";

const PAGE_WIDTH = 487;

/** Convert the prepared body into paginated text and embedded images. */
export async function createMemoPdfDefinition(html: string, signal: AbortSignal): Promise<TDocumentDefinitions> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const main = doc.querySelector("main");
  if (!main) throw new Error("无法读取导出正文");
  for (const checkbox of main.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    // Use glyphs included in the embedded CJK font.
    checkbox.replaceWith(doc.createTextNode(checkbox.checked ? "✓ " : "□ "));
  }
  for (const table of main.querySelectorAll("table")) {
    const columns = table.rows[0]?.cells.length || 1;
    table.dataset.pdfmake = JSON.stringify({ widths: Array(columns).fill("*"), headerRows: table.tHead ? 1 : 0 });
  }
  await Promise.all(
    Array.from(main.querySelectorAll("img")).map(async (element) => {
      if (!element.src.startsWith("data:image/")) throw new Error("图片尚未准备完成");
      const image = new Image();
      image.src = element.src;
      await image.decode();
      signal.throwIfAborted();
      if (!/^data:image\/(png|jpeg);/i.test(element.src)) {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法转换图片格式");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        element.src = canvas.toDataURL("image/png");
      }
      const columns = element.closest("table")?.rows[0]?.cells.length || 1;
      element.dataset.pdfmake = JSON.stringify({
        fit: [Math.min(image.naturalWidth, PAGE_WIDTH / columns - (columns > 1 ? 12 : 0)), 690],
        margin: [0, 6, 0, 10],
      });
    }),
  );
  signal.throwIfAborted();
  return {
    info: { title: doc.title },
    pageSize: "A4",
    pageMargins: [54, 48, 54, 48],
    defaultStyle: { font: "NotoSansSC", fontSize: 11, lineHeight: 1.35, color: "#171717" },
    content: htmlToPdfmake(main.innerHTML, {
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
}

const fontBase64 = async (name: string, signal: AbortSignal) => {
  const response = await fetch(`/fonts/noto-sans-sc/${name}.otf`, { signal, credentials: "same-origin" });
  if (!response.ok) throw new Error("中文字体加载失败，请重试");
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("中文字体读取失败，请重试"));
    reader.readAsDataURL(blob);
  });
};

/** Lazy-loaded by the export dialog; normal note browsing never loads PDF fonts. */
export async function createMemoPdf(html: string, signal: AbortSignal): Promise<Blob> {
  const loadingSignal = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  const [pdfMake, definition, regular, bold] = await Promise.all([
    import("pdfmake/build/pdfmake").then((module) => module.default),
    createMemoPdfDefinition(html, loadingSignal),
    fontBase64("Regular", loadingSignal),
    fontBase64("Bold", loadingSignal),
  ]);
  loadingSignal.throwIfAborted();
  pdfMake.addVirtualFileSystem({ "NotoSansSC-Regular.otf": regular, "NotoSansSC-Bold.otf": bold });
  pdfMake.addFonts({
    NotoSansSC: {
      normal: "NotoSansSC-Regular.otf",
      bold: "NotoSansSC-Bold.otf",
      italics: "NotoSansSC-Regular.otf",
      bolditalics: "NotoSansSC-Bold.otf",
    },
  });
  const blob = await pdfMake.createPdf(definition).getBlob();
  signal.throwIfAborted();
  return blob;
}
