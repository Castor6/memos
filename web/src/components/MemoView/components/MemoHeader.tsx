import { BookmarkIcon, ShieldOffIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import RelativeTime from "@/components/RelativeTime";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNewMemo } from "@/contexts/NewMemoContext";
import useNavigateTo from "@/hooks/useNavigateTo";
import i18n from "@/i18n";
import { Visibility } from "@/types/proto/api/v1/memo_service_pb";
import type { User } from "@/types/proto/api/v1/user_service_pb";
import { useTranslate } from "@/utils/i18n";
import { extractTasksFromAst } from "@/utils/markdown-manipulation";
import { convertVisibilityToString } from "@/utils/memo";
import { countMemoWords } from "@/utils/word-count";
import MemoActionMenu from "../../MemoActionMenu";
import { ReactionSelector } from "../../MemoReactionListView";
import UserAvatar from "../../UserAvatar";
import VisibilityIcon from "../../VisibilityIcon";
import { useMemoViewContext, useMemoViewDerived } from "../MemoViewContext";
import type { MemoHeaderProps } from "../types";

const MemoHeader: React.FC<MemoHeaderProps> = ({ showCreator, showVisibility, showPinned, contextMenuPosition, onContextMenuClose }) => {
  const t = useTranslate();

  const { memo, creator, currentUser, parentPage, isArchived, readonly, openEditor } = useMemoViewContext();
  const wordCount = useMemo(() => countMemoWords(memo.content), [memo.content]);
  const tasks = memo.isTodo ? extractTasksFromAst(memo.content) : [];
  const { createTime, updateTime, displayTime: memoDisplayTime, isDisplayingUpdatedTime, relativeTimeFormat } = useMemoViewDerived();
  const { newMemoName } = useNewMemo();

  const navigateTo = useNavigateTo();
  const handleGotoMemoDetailPage = useCallback(() => {
    navigateTo(`/${memo.name}`, { state: { from: parentPage } });
  }, [memo.name, parentPage, navigateTo]);

  const timeValue = isArchived ? (
    memoDisplayTime?.toLocaleString(i18n.language)
  ) : (
    <RelativeTime date={memoDisplayTime} format={relativeTimeFormat} />
  );
  const displayTime = isDisplayingUpdatedTime ? (
    <>
      {t("common.last-updated-at")} {timeValue}
    </>
  ) : (
    timeValue
  );
  const timeTooltip = {
    createdAt: createTime ? `${t("common.created-at")}: ${createTime.toLocaleString(i18n.language)}` : undefined,
    updatedAt:
      updateTime && (!createTime || updateTime.getTime() !== createTime.getTime())
        ? `${t("common.last-updated-at")}: ${updateTime.toLocaleString(i18n.language)}`
        : undefined,
  };

  return (
    <div className="w-full flex flex-row justify-between items-center gap-2">
      <div className="min-w-0 grow flex flex-row flex-wrap justify-start items-center gap-x-2 gap-y-1">
        {showPinned && memo.pinned && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
            <BookmarkIcon className="size-3" />
            {t("memo.pinned-badge")}
          </span>
        )}
        {memo.mcpHidden && !readonly && (
          <Tooltip>
            <TooltipTrigger
              render={<span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground" tabIndex={0} />}
            >
              <ShieldOffIcon className="size-3" />
              {t("memo.mcp-privacy.label")}
            </TooltipTrigger>
            <TooltipContent>{t("memo.mcp-privacy.description")}</TooltipContent>
          </Tooltip>
        )}
        {showCreator && creator ? (
          <CreatorDisplay creator={creator} displayTime={displayTime} timeTooltip={timeTooltip} onGotoDetail={handleGotoMemoDetailPage} />
        ) : (
          <TimeDisplay displayTime={displayTime} timeTooltip={timeTooltip} onGotoDetail={handleGotoMemoDetailPage} />
        )}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t("memo.word-count", { count: wordCount })}</span>
        {memo.name === newMemoName && (
          <span className="ml-2 shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium leading-none text-primary">
            {t("memo.new-badge")}
          </span>
        )}
      </div>

      <div className="flex flex-row justify-end items-center select-none shrink-0 gap-2">
        {currentUser && !isArchived && <ReactionSelector className="border-none w-auto h-auto block" memo={memo} />}

        {showVisibility && memo.visibility !== Visibility.PRIVATE && (
          <Tooltip>
            <TooltipTrigger>
              <span className="flex justify-center items-center rounded-md hover:opacity-80">
                <VisibilityIcon visibility={memo.visibility} />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t(`memo.visibility.${convertVisibilityToString(memo.visibility).toLowerCase()}` as Parameters<typeof t>[0])}
            </TooltipContent>
          </Tooltip>
        )}

        {memo.isTodo && (
          <span className="text-sm text-muted-foreground" aria-label="待办完成进度">
            ☑ {tasks.filter((task) => task.checked).length}/{tasks.length}
          </span>
        )}
        <MemoActionMenu
          memo={memo}
          readonly={readonly}
          onEdit={openEditor}
          contextMenuPosition={contextMenuPosition}
          onContextMenuClose={onContextMenuClose}
        />
      </div>
    </div>
  );
};

interface CreatorDisplayProps {
  creator: User;
  displayTime: React.ReactNode;
  timeTooltip: TimeTooltipContent;
  onGotoDetail: () => void;
}

const CreatorDisplay: React.FC<CreatorDisplayProps> = ({ creator, displayTime, timeTooltip, onGotoDetail }) => (
  <div className="min-w-0 flex-1 flex flex-row justify-start items-center">
    <Link className="w-auto hover:opacity-80 rounded-md transition-colors" to={`/u/${encodeURIComponent(creator.username)}`} viewTransition>
      <UserAvatar className="mr-2 shrink-0" avatarUrl={creator.avatarUrl} />
    </Link>
    <div className="min-w-0 flex-1 flex flex-col justify-center items-start">
      <Link
        className="max-w-full block leading-tight hover:opacity-80 rounded-md transition-colors truncate text-muted-foreground"
        to={`/u/${encodeURIComponent(creator.username)}`}
        viewTransition
      >
        {creator.displayName || creator.username}
      </Link>
      <TimeTooltip content={timeTooltip}>
        <span
          className="w-auto -mt-0.5 text-xs leading-tight text-muted-foreground select-none cursor-pointer hover:opacity-80 transition-colors text-left"
          onClick={onGotoDetail}
        >
          {displayTime}
        </span>
      </TimeTooltip>
    </div>
  </div>
);

interface TimeTooltipContent {
  createdAt?: string;
  updatedAt?: string;
}

const TimeTooltip = ({ children, content }: { children: React.ReactElement; content: TimeTooltipContent }) => (
  <Tooltip>
    <TooltipTrigger render={children} />
    <TooltipContent align="start" className="flex flex-col items-start gap-0.5 whitespace-nowrap text-left">
      {content.createdAt && <span>{content.createdAt}</span>}
      {content.updatedAt && <span>{content.updatedAt}</span>}
    </TooltipContent>
  </Tooltip>
);

interface TimeDisplayProps {
  displayTime: React.ReactNode;
  timeTooltip: TimeTooltipContent;
  onGotoDetail: () => void;
}

const TimeDisplay: React.FC<TimeDisplayProps> = ({ displayTime, timeTooltip, onGotoDetail }) => (
  <TimeTooltip content={timeTooltip}>
    <span
      className="w-auto text-sm leading-tight text-muted-foreground select-none cursor-pointer hover:text-foreground transition-colors text-left"
      onClick={onGotoDetail}
    >
      {displayTime}
    </span>
  </TimeTooltip>
);

export default MemoHeader;
