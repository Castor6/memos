import ClampedSection from "@/components/ClampedSection";
import { Tag } from "@/components/MemoContent/Tag";
import MemoContentMask from "@/components/MemoContentMask";
import { LocationDisplayView, RelationListView } from "@/components/MemoMetadata";
import { isReferenceRelation } from "@/components/MemoMetadata/Relation/relationHelpers";
import { useAuth } from "@/contexts/AuthContext";
import { useMemoPrivacy } from "@/contexts/PrivateMemoVisibilityContext";
import { FILE_TITLE, fileMarkdown } from "@/lib/inline-media";
import { getAttachmentUrl } from "@/utils/attachment";
import { useTranslate } from "@/utils/i18n";
import { visibleCharacterCount } from "@/utils/remark-plugins/remark-preview";
import MemoContent from "../../MemoContent";
import { MemoReactionListView } from "../../MemoReactionListView";
import { useMemoHandlers } from "../hooks";
import { useMemoViewContext } from "../MemoViewContext";
import type { MemoBodyProps } from "../types";

const MemoBody: React.FC<MemoBodyProps> = ({ compact, privacyEnabled = true }) => {
  const t = useTranslate();
  const { userGeneralSetting } = useAuth();
  const limit = userGeneralSetting?.previewCharacters ?? 0;
  const { memo, parentPage, showBlurredContent, blurred, readonly, openEditor, openPreview, toggleBlurVisibility } = useMemoViewContext();

  const privateMemo = privacyEnabled && memo.mcpHidden;
  const privacy = useMemoPrivacy({ ...memo, mcpHidden: Boolean(privateMemo) });
  const hidden = privateMemo ? privacy.hidden : blurred && !showBlurredContent;

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
        <MemoReactionListView memo={memo} reactions={memo.reactions} />
      </div>
    </MemoContentMask>
  );
};

export default MemoBody;
