import { MoreHorizontalIcon, PencilIcon, SmileIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import TagsSection from "@/components/Settings/TagsSection";
import TagActionDialog from "@/components/TagActionDialog";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAuth } from "@/contexts/AuthContext";

export const TagSettingsDialog = ({ tag, open, onOpenChange }: { tag?: string; open: boolean; onOpenChange: (open: boolean) => void }) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="2xl" initialFocus onContextMenu={(event) => event.stopPropagation()}>
      <DialogTitle className="break-all pr-6">{tag === undefined ? "管理标签规则" : `设置标签：${tag}`}</DialogTitle>
      {open && <TagsSection tag={tag} onSaved={() => onOpenChange(false)} />}
    </DialogContent>
  </Dialog>
);

const TagSettingsMenu = ({ tag, children }: { tag: string; children: ReactNode }) => {
  const { currentUser } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
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
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {action && <TagActionDialog tag={tag} action={action} onClose={() => setAction(null)} />}
    </div>
  );
};

export default TagSettingsMenu;
