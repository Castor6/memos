import { create } from "@bufbuild/protobuf";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { MemoMarkdownRendererCore } from "@/components/MemoContent/MemoMarkdownRenderer";
import { MemoViewContext, type MemoViewContextValue } from "@/components/MemoView/MemoViewContext";
import { withShareAttachmentLinks } from "@/hooks/useMemoShareQueries";
import { AttachmentSchema } from "@/types/proto/api/v1/attachment_service_pb";
import { MemoSchema } from "@/types/proto/api/v1/memo_service_pb";
import { resolveInlineAttachmentUrl } from "@/utils/inline-attachment";

const origin = window.location.origin;
const attachment = create(AttachmentSchema, { name: "attachments/clip123", filename: "photo one.webp", type: "image/webp" });
const local = "/file/attachments/clip123/photo%20one.webp";
const token = "private-share-token";
const shared = withShareAttachmentLinks([attachment], token);

describe("inline attachment authorization", () => {
  it("renders shared memo images with the existing attachment authorization, including nested content", () => {
    const content = `Before\n\n> ![archived](${local})\n\n![outside](https://outside.example.com${local})\n\n![unrelated](/file/attachments/other/photo.webp)`;
    const memo = create(MemoSchema, { name: "memos/shared", content, attachments: shared });
    render(
      <MemoryRouter>
        <MemoViewContext.Provider value={{ memo } as MemoViewContextValue}>
          <MemoMarkdownRendererCore content={content} resolvedMentionUsernames={new Set()} />
        </MemoViewContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByAltText("archived")).toHaveAttribute("src", `${origin}${local}?share_token=${token}`);
    expect(screen.getByAltText("outside")).toHaveAttribute("src", `https://outside.example.com${local}`);
    expect(screen.getByAltText("unrelated")).toHaveAttribute("src", "/file/attachments/other/photo.webp");
    expect(memo.content).toBe(content);
  });

  it("leaves normal local attachments and standalone rendering unchanged", () => {
    expect(resolveInlineAttachmentUrl(local, [attachment], origin)).toBe(local);
    render(<MemoMarkdownRendererCore content={`![local](${local})`} resolvedMentionUsernames={new Set()} />);
    expect(screen.getByAltText("local")).toHaveAttribute("src", local);
  });

  it("matches only the full attachment route of this memo on this origin", () => {
    for (const source of [
      `https://other.example${local}`,
      `//other.example${local}`,
      "/file/attachments/clip123/wrong.webp",
      "/file/attachments/unknown/photo%20one.webp",
    ])
      expect(resolveInlineAttachmentUrl(source, shared, origin)).toBe(source);
    expect(resolveInlineAttachmentUrl(`${origin}${local}`, shared, origin)).toBe(`${origin}${local}?share_token=${token}`);
  });

  it("uses authorized S3 URLs but never transfers a share token to an external host", () => {
    const s3 = "https://storage.example/photo.webp?signature=authorized";
    expect(resolveInlineAttachmentUrl(local, [{ ...attachment, externalLink: s3 }], origin)).toBe(s3);
    expect(resolveInlineAttachmentUrl(local, [{ ...attachment, externalLink: `${s3}&share_token=${token}` }], origin)).toBe(local);
  });
});
