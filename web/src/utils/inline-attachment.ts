import type { Attachment } from "@/types/proto/api/v1/attachment_service_pb";

/** Resolve only this memo's local attachment routes to its already-authorized display URLs. */
export function resolveInlineAttachmentUrl(src: string, attachments: readonly Attachment[], origin: string): string {
  try {
    const source = new URL(src, origin);
    if (source.origin !== origin || source.username || source.password) return src;
    const attachment = attachments.find((item) => source.pathname === `/file/${item.name}/${encodeURIComponent(item.filename)}`);
    if (!attachment?.externalLink) return src;
    const authorized = new URL(attachment.externalLink, origin);
    if (!["https:", "http:"].includes(authorized.protocol) || authorized.username || authorized.password) return src;
    // Share credentials belong to the Memos file server, never an external image host.
    if (authorized.origin !== origin && authorized.searchParams.has("share_token")) return src;
    return authorized.href;
  } catch {
    return src;
  }
}
