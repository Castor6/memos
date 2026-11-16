import { create } from "@bufbuild/protobuf";
import { useQueryClient } from "@tanstack/react-query";
import { LayoutGridIcon, MoreHorizontalIcon, PencilIcon, SmileIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import TagsSection from "@/components/Settings/TagsSection";
import TagActionDialog from "@/components/TagActionDialog";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSwitchItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/contexts/AuthContext";
import { memoKeys } from "@/hooks/useMemoQueries";
import { useUpdateUserSetting } from "@/hooks/useUserQueries";
import { handleError } from "@/lib/error";
import { buildUserSettingName } from "@/lib/resource-names";
import { applyImageGridToggle, resolveTagImageGrid } from "@/lib/tag";
import {
  UserSetting_Key,
  type UserSetting_TagMetadata,
  UserSetting_TagMetadataSchema,
  UserSetting_TagsSettingSchema,
  UserSettingSchema,
} from "@/types/proto/api/v1/user_service_pb";

export const TagSettingsDialog = ({ tag, open, onOpenChange }: { tag?: string; open: boolean; onOpenChange: (open: boolean) => void }) => {
  // Focus the dialog itself: focusing the tag name input would pop up its suggestion list on open.
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={popupRef} size="2xl" initialFocus={popupRef} onContextMenu={(event) => event.stopPropagation()}>
        <DialogTitle className="break-all pr-6">{tag === undefined ? "管理标签规则" : `设置标签：${tag}`}</DialogTitle>
        {/* Kept rendered during the close animation; the popup unmounts afterwards, so drafts still reset on reopen. */}
        <TagsSection tag={tag} onSaved={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
};

const isEmptyTagMetadata = (rule: UserSetting_TagMetadata) =>
  !rule.emoji && !rule.backgroundColor && !rule.blurContent && rule.imageGrid === undefined;

const TagSettingsMenu = ({ tag, children }: { tag: string; children: ReactNode }) => {
  const { currentUser, userTagsSetting, refetchSettings } = useAuth();
  const queryClient = useQueryClient();
  const { mutateAsync: updateSetting, isPending } = useUpdateUserSetting();
  const [menuOpen, setMenuOpen] = useState(false);
  const imageGrid = userTagsSetting ? resolveTagImageGrid(tag, userTagsSetting) : { enabled: false };
  // Sets this tag's value and makes all child tags follow it again; empty exact rules are dropped.
  const toggleImageGrid = async (checked: boolean) => {
    if (!currentUser) return;
    const tags = applyImageGridToggle(userTagsSetting?.tags ?? {}, tag, checked, {
      create: (inherited) => create(UserSetting_TagMetadataSchema, inherited),
      isEmpty: isEmptyTagMetadata,
    });
    try {
      await updateSetting({
        setting: create(UserSettingSchema, {
          name: buildUserSettingName(currentUser.name, UserSetting_Key.TAGS),
          value: { case: "tagsSetting", value: create(UserSetting_TagsSettingSchema, { tags }) },
        }),
        updateMask: ["tags"],
      });
      await refetchSettings();
      await queryClient.invalidateQueries({ queryKey: memoKeys.all });
    } catch (error) {
      await handleError(error, toast.error, { context: "保存图片网格设置失败" });
    }
  };
  const [action, setAction] = useState<"rename" | "icon" | null>(null);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  return (
    <div
      className="flex min-w-0 w-full items-center gap-1"
      onContextMenu={(event) => {
        if (!currentUser) return;
        event.preventDefault();
        event.stopPropagation();
        setPoint({ x: event.clientX, y: event.clientY });
        setMenuOpen(true);
      }}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {currentUser && (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            onPointerDown={() => setPoint(null)}
            onKeyDown={() => setPoint(null)}
            aria-label={`标签 ${tag} 的更多操作`}
            className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <MoreHorizontalIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align={point ? "start" : "end"}
            side="bottom"
            anchor={point ? { getBoundingClientRect: () => new DOMRect(point.x, point.y, 0, 0) } : undefined}
          >
            <DropdownMenuItem onClick={() => setAction("rename")}>
              <PencilIcon className="size-4" />
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setAction("icon")}>
              <SmileIcon className="size-4" />
              设置图标
            </DropdownMenuItem>
            <DropdownMenuSwitchItem
              checked={imageGrid.enabled}
              disabled={isPending}
              onCheckedChange={(checked) => void toggleImageGrid(checked)}
            >
              <LayoutGridIcon className="size-4" />
              <span className="flex min-w-0 flex-col">
                <span>图片网格</span>
                {imageGrid.source && <span className="truncate text-xs text-muted-foreground">跟随 {imageGrid.source}</span>}
              </span>
            </DropdownMenuSwitchItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {action && <TagActionDialog tag={tag} action={action} onClose={() => setAction(null)} />}
    </div>
  );
};

export default TagSettingsMenu;
