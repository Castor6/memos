import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import "./markdown-preview.css";

/** Render captured Markdown with sanitized HTML, including the source details fold. */
export function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="markdown-preview">
      <ReactMarkdown
        remarkPlugins={[remarkBreaks, remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={{
          a: ({ children, href, title }) => (
            <a href={href} title={title} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt, title }) =>
            src ? <img src={src} alt={alt || ""} title={title} loading="lazy" referrerPolicy="no-referrer" /> : null,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
