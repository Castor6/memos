import ClampedSection from "@/components/ClampedSection";
import { Tag } from "@/components/MemoContent/Tag";
import { LocationDisplayView, RelationListView } from "@/components/MemoMetadata";
import { isReferenceRelation } from "@/components/MemoMetadata/Relation/relationHelpers";
import { useAuth } from "@/contexts/AuthContext";
import { FILE_TITLE, fileMarkdown } from "@/lib/inline-media";
import { cn } from "@/lib/utils";
import { getAttachmentUrl } from "@/utils/attachment";
import { useTranslate } from "@/utils/i18n";
import { visibleCharacterCount } from "@/utils/remark-plugins/remark-preview";
import MemoContent from "../../MemoContent";
import { MemoReactionListView } from "../../MemoReactionListView";
import { useMemoHandlers } from "../hooks";
import { useMemoViewContext } from "../MemoViewContext";
import type { MemoBodyProps } from "../types";

const BlurOverlay: React.FC<{ onClick?: () => void }> = ({ onClick }) => {
  const t = useTranslate();
  return (
    <div className="absolute inset-0 z-10 pt-4 flex items-center justify-center" onClick={onClick}>
      <div className="rounded-lg border border-border bg-card px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-accent hover:bg-accent hover:text-foreground">
        {t("memo.click-to-show-sensitive-content")}
      </div>
    </div>
  );
};

const MemoBody: React.FC<MemoBodyProps> = ({ compact }) => {
  const { userGeneralSetting } = useAuth();
  const limit = userGeneralSetting?.previewCharacters ?? 0;
  const { memo, parentPage, showBlurredContent, blurred, readonly, openEditor, openPreview, toggleBlurVisibility } = useMemoViewContext();

  const { handleMemoContentClick, handleMemoContentDoubleClick } = useMemoHandlers({ readonly, openEditor, openPreview });

  const referencedMemos = memo.relations
    .filter(isReferenceRelation)
    .filter((relation) => !memo.content.includes(`/${relation.relatedMemo?.name}`));
  const content =
    memo.content +
    memo.attachments
      .filter((file) => !memo.content.includes(file.name) && !memo.content.includes(getAttachmentUrl(file)))
      .map(
        (file) => `

${fileMarkdown(getAttachmentUrl(file), FILE_TITLE + file.type, file.filename)}`,
      )
      .join("");

  return (
    <>
      <div
        className={cn(
          "w-full flex flex-col justify-start items-start gap-2",
          blurred && !showBlurredContent && "blur-lg transition-all duration-200",
        )}
      >
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
        <MemoReactionListView memo={memo} reactions={memo.reactions} />
      </div>

      {blurred && !showBlurredContent && <BlurOverlay onClick={toggleBlurVisibility} />}
    </>
  );
};

export default MemoBody;
