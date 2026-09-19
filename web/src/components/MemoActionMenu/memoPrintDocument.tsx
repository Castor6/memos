import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const PRINT_CSS = `
@page { size: A4; margin: 18mm; }
* { box-sizing: border-box; }
body { margin: 0; background: white; color: #171717; font: 12pt/1.65 system-ui, sans-serif; overflow-wrap: anywhere; }
main { max-width: 760px; margin: auto; padding: 24px; }
h1,h2,h3,h4,h5,h6 { line-height: 1.3; break-after: avoid; }
h1 { font-size: 24pt; } h2 { font-size: 19pt; } h3 { font-size: 15pt; }
p,ul,ol,pre,blockquote,table { margin: 0 0 1em; }
img { display: block; max-width: 100%; max-height: 235mm; width: auto; height: auto; object-fit: contain; break-inside: avoid; margin: 12px 0; }
a { color: #235da8; text-decoration: underline; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; background: #f5f5f5; border: 1px solid #ddd; }
code { font-family: ui-monospace, monospace; font-size: 0.9em; }
blockquote { border-left: 3px solid #ccc; padding-left: 16px; margin-left: 0; color: #555; }
table { border-collapse: collapse; width: 100%; table-layout: fixed; }
th,td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
tr { break-inside: avoid; } thead { display: table-header-group; }
input[type=checkbox] { margin-right: 6px; }
@media print { main { max-width: none; padding: 0; } body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
`;

const blobAsDataURL = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取图片"));
    reader.readAsDataURL(blob);
  });

/** Build an isolated, script-free print document and embed every body image. */
export async function createMemoPrintDocument(markdown: string, title: string, signal: AbortSignal): Promise<string> {
  const body = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{markdown}</ReactMarkdown>);
  const doc = new DOMParser().parseFromString("<!doctype html><html><head></head><body><main></main></body></html>", "text/html");
  doc.title = title;
  doc.documentElement.lang = document.documentElement.lang || "zh-CN";
  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  doc.head.prepend(charset);
  const style = doc.createElement("style");
  style.textContent = PRINT_CSS;
  doc.head.append(style);
  const main = doc.querySelector("main");
  if (!main) throw new Error("无法创建导出文档");
  main.innerHTML = body;
  // React may emit image preloads; embedded images must not request the remote source again.
  for (const preload of main.querySelectorAll("link")) preload.remove();
  const images = Array.from(main.querySelectorAll("img"));
  const sources = new Map<string, Promise<string>>();
  const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  await Promise.all(
    images.map(async (image) => {
      const src = image.getAttribute("src") || "";
      if (!/^https?:\/\//i.test(src)) throw new Error("图片地址无效，无法导出完整 PDF");
      let loading = sources.get(src);
      if (!loading) {
        loading = (async () => {
          const response = await fetch(src, { signal: combinedSignal, credentials: "same-origin" });
          if (!response.ok) throw new Error("图片读取失败，请确认图片可以打开后重试");
          const blob = await response.blob();
          if (!blob.type.startsWith("image/")) throw new Error("附件没有返回有效图片");
          return blobAsDataURL(blob);
        })();
        sources.set(src, loading);
      }
      image.src = await loading;
      image.removeAttribute("loading");
    }),
  );
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
