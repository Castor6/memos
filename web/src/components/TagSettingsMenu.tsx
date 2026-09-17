import { MoreHorizontalIcon, SettingsIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import TagsSection from "@/components/Settings/TagsSection";
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
  const [editing, setEditing] = useState(false);
  return (
    <div
      className="flex min-w-0 w-full items-center gap-1"
      onContextMenu={(event) => {
        if (!currentUser) return;
        event.preventDefault();
        event.stopPropagation();
        setMenuOpen(true);
      }}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {currentUser && (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            aria-label={`标签 ${tag} 的更多操作`}
            className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <MoreHorizontalIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setEditing(true)}>
              <SettingsIcon className="size-4" />
              设置标签
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <TagSettingsDialog tag={tag} open={editing} onOpenChange={setEditing} />
    </div>
  );
};

export default TagSettingsMenu;
