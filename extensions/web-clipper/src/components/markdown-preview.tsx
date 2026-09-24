import { useEffect, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import browser from "webextension-polyfill";
import type { AttachmentPreviewResult, PreviewConnection } from "@/lib/messages";
import { sendBackgroundRequest } from "@/lib/runtime-client";
import "./markdown-preview.css";

const previewSchema = {
  ...defaultSchema,
  protocols: { ...defaultSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), "data"] },
};

function previewUrlTransform(url: string, key: string): string {
  if (/^data:/i.test(url)) {
    return key === "src" && url.length <= 14 * 1024 * 1024 && /^data:image\/(png|jpeg|gif|webp|avif);base64,[a-z\d+/]+={0,2}$/i.test(url)
      ? url
      : "";
  }
  return defaultUrlTransform(url);
}

function AttachmentImage({ path, alt, title, connection }: { path: string; alt?: string; title?: string; connection?: PreviewConnection }) {
  const [result, setResult] = useState<AttachmentPreviewResult | null>(null);
  const source = connection?.expectedSource;
  const connectionId = connection?.expectedConnectionId;
  const instanceUrl = connection?.expectedInstanceUrl;
  useEffect(() => {
    let active = true;
    setResult(null);
    const onAuth = (message: unknown) => {
      if (message && typeof message === "object" && "type" in message && message.type === "AUTH_CHANGED") {
        active = false;
        setResult({ ok: false });
      }
      return undefined;
    };
    browser.runtime.onMessage.addListener(onAuth);
    if (source && connectionId && instanceUrl) {
      void sendBackgroundRequest({
        type: "GET_ATTACHMENT_PREVIEW",
        path,
        expectedSource: source,
        expectedConnectionId: connectionId,
        expectedInstanceUrl: instanceUrl,
      })
        .then((value) => {
          if (active) setResult(value ?? { ok: false });
        })
        .catch(() => {
          if (active) setResult({ ok: false });
        });
    } else setResult({ ok: false });
    return () => {
      active = false;
      browser.runtime.onMessage.removeListener(onAuth);
    };
  }, [path, source, connectionId, instanceUrl]);
  return result?.ok ? (
    <img src={result.dataUrl} alt={alt || ""} title={title} />
  ) : (
    <span role="img" aria-label={alt || "附件图片"}>
      {alt || "附件图片"} · {result ? "图片预览不可用，请在 Memos 中查看" : "正在加载图片…"}
    </span>
  );
}

/** Render captured Markdown with sanitized HTML, including the source details fold. */
export function MarkdownPreview({
  content,
  connection,
  expanded = false,
}: {
  content: string;
  connection?: PreviewConnection;
  expanded?: boolean;
}) {
  return (
    <div className="markdown-preview">
      <ReactMarkdown
        remarkPlugins={[remarkBreaks, remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, previewSchema]]}
        urlTransform={previewUrlTransform}
        components={{
          ...(expanded
            ? {
                details: ({ children }: { children?: React.ReactNode }) => <section>{children}</section>,
                summary: ({ children }: { children?: React.ReactNode }) => (children === "展开原内容" ? null : <h3>{children}</h3>),
              }
            : {}),
          a: ({ children, href, title }) => (
            <a href={href} title={title} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt, title }) => {
            if (src?.startsWith("/file/attachments/"))
              return <AttachmentImage key={JSON.stringify([src, connection])} path={src} alt={alt} title={title} connection={connection} />;
            return src ? <img src={src} alt={alt || ""} title={title} loading="lazy" referrerPolicy="no-referrer" /> : null;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
