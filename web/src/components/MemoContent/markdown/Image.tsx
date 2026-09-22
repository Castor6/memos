import { useContext } from "react";
import { MemoViewContext } from "@/components/MemoView/MemoViewContext";
import { cn } from "@/lib/utils";
import { resolveInlineAttachmentUrl } from "@/utils/inline-attachment";
import { InlineFile } from "../InlineFile";
import type { ReactMarkdownProps } from "./types";

interface ImageProps extends React.ImgHTMLAttributes<HTMLImageElement>, ReactMarkdownProps {}

/**
 * Image component for markdown images
 * Responsive with rounded corners
 */
export const Image = ({ className, alt, node: _node, height, width, style, ...props }: ImageProps) => {
  const context = useContext(MemoViewContext);
  const src =
    typeof props.src === "string" && context
      ? resolveInlineAttachmentUrl(props.src, context.memo.attachments, window.location.origin)
      : props.src;
  if (props.title?.startsWith("memos:"))
    return <InlineFile src={typeof src === "string" ? src : ""} title={props.title} label={alt || "文件"} />;
  return (
    <img
      className={cn("max-w-full max-h-80 w-auto object-contain object-left my-2", !height && "h-auto", className)}
      alt={alt}
      style={{
        height: height ? `${height}px` : undefined,
        width: width ? `${width}px` : undefined,
        ...style,
        maxWidth: "min(100%, 30rem)",
        maxHeight: "20rem",
      }}
      {...props}
      src={src}
      loading="lazy"
      decoding="async"
    />
  );
};
