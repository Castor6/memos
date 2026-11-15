import { useMemo } from "react";
import ClampedSection from "@/components/ClampedSection";
import { Tag } from "@/components/MemoContent/Tag";
import MemoContentMask from "@/components/MemoContentMask";
import { LocationDisplayView, RelationListView } from "@/components/MemoMetadata";
import { isReferenceRelation } from "@/components/MemoMetadata/Relation/relationHelpers";
import { useAuth } from "@/contexts/AuthContext";
import { useMemoPrivacy } from "@/contexts/PrivateMemoVisibilityContext";
import { FILE_TITLE, fileMarkdown } from "@/lib/inline-media";
import { splitMemoImages } from "@/lib/memo-image-grid";
import { hasImageGridTag } from "@/lib/tag";
import { getAttachmentUrl, isImage } from "@/utils/attachment";
import { useTranslate } from "@/utils/i18n";
import { visibleCharacterCount } from "@/utils/remark-plugins/remark-preview";
import MemoContent from "../../MemoContent";
import { MemoReactionListView } from "../../MemoReactionListView";
import { useMemoHandlers } from "../hooks";
import { useMemoViewContext } from "../MemoViewContext";
import type { MemoBodyProps } from "../types";
import MemoImageGrid from "./MemoImageGrid";

const MemoBody: React.FC<MemoBodyProps> = ({ compact, privacyEnabled = true }) => {
  const t = useTranslate();
  const { userGeneralSetting, userTagsSetting } = useAuth();
  const limit = userGeneralSetting?.previewCharacters ?? 0;
  const { memo, parentPage, showBlurredContent, blurred, readonly, openEditor, openPreview, toggleBlurVisibility } = useMemoViewContext();

  const privateMemo = privacyEnabled && memo.mcpHidden;
  const privacy = useMemoPrivacy({ ...memo, mcpHidden: Boolean(privateMemo) });
  const hidden = privateMemo ? privacy.hidden : blurred && !showBlurredContent;

  const { handleMemoContentClick, handleMemoContentDoubleClick } = useMemoHandlers({ readonly, openEditor, openPreview });

  const referencedMemos = memo.relations
    .filter(isReferenceRelation)
    .filter((relation) => !memo.content.includes(`/${relation.relatedMemo?.name}`));
  // Image-grid tags only change presentation: images leave the body for a grid below it.
  const imageGrid = hasImageGridTag(memo.tags, userTagsSetting);
  const { body, images } = useMemo(
    () => (imageGrid ? splitMemoImages(memo.content, memo.attachments) : { body: memo.content, images: [] }),
    [imageGrid, memo.content, memo.attachments],
  );
  const content =
    body +
    memo.attachments
      .filter((file) => !memo.content.includes(file.name) && !memo.content.includes(getAttachmentUrl(file)))
      .filter((file) => !imageGrid || !isImage(file.type))
      .map(
        (file) => `

${fileMarkdown(getAttachmentUrl(file), FILE_TITLE + file.type, file.filename)}`,
      )
      .join("");

  return (
    <MemoContentMask
      hidden={hidden}
      onReveal={privateMemo ? privacy.reveal : toggleBlurVisibility}
      label={t(privateMemo ? "memo.mcp-privacy.show-content" : "memo.click-to-show-sensitive-content")}
      showLabel={!privateMemo}
      className="w-full"
    >
      <div className="w-full flex flex-col justify-start items-start gap-2">
        {/* Compact bounds the whole body — attachments included — behind one Show more.
            Reactions stay outside so they never hide under the fade. */}
        <ClampedSection enabled={Boolean(compact)} characterLimit={limit} textLength={visibleCharacterCount(content)}>
          {(collapsed) => (
            <>
              {memo.tags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {memo.tags.map((tag) => (
                    <Tag key={tag} data-tag={tag}>
                      {tag}
                    </Tag>
                  ))}
                </div>
              )}
              <MemoContent
                linkMetadata={memo.linkMetadata}
                memoName={memo.name}
                content={content}
                explicitTags={memo.explicitTags}
                displayedTags={memo.tags}
                maxCharacters={collapsed ? limit : 0}
                onClick={handleMemoContentClick}
                onDoubleClick={handleMemoContentDoubleClick}
                compact={Boolean(compact)}
              />
              <RelationListView relations={referencedMemos} currentMemoName={memo.name} parentPage={parentPage} />
              {memo.location && <LocationDisplayView location={memo.location} />}
            </>
          )}
        </ClampedSection>
        {/* Outside the clamp so collapsed long memos still show every image. */}
        <MemoImageGrid
          images={images}
          onOpen={(index) =>
            openPreview(
              images.map((image) => ({
                id: image.key,
                kind: "image" as const,
                sourceUrl: image.src,
                posterUrl: image.thumbnail,
                filename: image.alt,
              })),
              index,
            )
          }
        />
        <MemoReactionListView memo={memo} reactions={memo.reactions} />
      </div>
    </MemoContentMask>
  );
};

export default MemoBody;
