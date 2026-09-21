import type React from "react";
import { useLinkMetadata } from "@/hooks/useMemoQueries";
import { cn } from "@/lib/utils";
import { useMarkdownRenderContext } from "./MarkdownRenderContext";

interface LinkMetadataCardProps {
  url: string;
  fallback: React.ReactNode;
  enabled?: boolean;
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const LinkMetadataCard = ({ url, fallback, enabled = true }: LinkMetadataCardProps) => {
  const { linkMetadata } = useMarkdownRenderContext();
  const saved = linkMetadata?.find((item) => item.url === url);
  const query = useLinkMetadata(url, { enabled: enabled && !saved });
  const metadata = saved ?? query.data;
  const isSuccess = Boolean(saved) || query.isSuccess;

  const title = metadata?.title.trim() ?? "";
  const description = metadata?.description.trim() ?? "";
  const hostname = getHostname(metadata?.url || url);

  if (!saved && (query.isLoading || !enabled)) {
    return (
      <div className="my-0 mb-2 min-h-20 w-full rounded-md border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
        <span>正在读取链接预览…</span>
        {fallback}
      </div>
    );
  }
  if (!isSuccess || title === "") {
    return fallback;
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "group my-0 mb-2 flex w-full max-w-full overflow-hidden rounded-md border border-border bg-muted/20 text-foreground no-underline transition-colors",
        "hover:border-primary/35 hover:bg-accent/20",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 px-2.5 py-2 sm:gap-1 sm:px-3 sm:py-2.5">
        {hostname && <span className="truncate text-[11px] leading-4 text-muted-foreground sm:text-xs">{hostname}</span>}
        {title && <span className="line-clamp-2 text-sm font-medium leading-5 text-foreground">{title}</span>}
        {description && <span className="line-clamp-1 text-xs leading-4 text-muted-foreground sm:line-clamp-2">{description}</span>}
      </span>
    </a>
  );
};

export default LinkMetadataCard;
