import { Link } from "react-router-dom";
import { FILE_TITLE, REFERENCE_TITLE, safeMediaURL } from "@/lib/inline-media";

export function InlineFile({ src, title, label }: { src: string; title: string; label: string }) {
  const url = safeMediaURL(src);
  if (!url) return <span>{label}</span>;
  if (title === REFERENCE_TITLE) {
    return /^\/memos\/[a-zA-Z0-9-]+$/.test(url) ? (
      <Link to={url} className="my-2 block rounded-lg border bg-muted/40 p-3 hover:bg-muted" onClick={(event) => event.stopPropagation()}>
        <span className="block text-xs text-muted-foreground mb-1">↗ 笔记引用</span>
        <span className="line-clamp-3">{label}</span>
      </Link>
    ) : (
      <span>{label}</span>
    );
  }
  const type = title.slice(FILE_TITLE.length);
  if (type.startsWith("video/")) return <video className="my-2 max-w-full max-h-96 rounded-lg" src={url} controls preload="metadata" />;
  if (type.startsWith("audio/")) return <audio className="my-2 max-w-full" src={url} controls preload="metadata" />;
  if (type.startsWith("image/")) return <img className="my-2 max-w-full rounded-lg" src={url} alt={label} loading="lazy" />;
  return (
    <a
      className="my-2 block rounded-lg border bg-muted/40 px-4 py-3 hover:bg-muted"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
    >
      📎 {label}
      <span className="ml-2 text-xs text-muted-foreground">打开 / 下载</span>
    </a>
  );
}
