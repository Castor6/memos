import { CheckIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { type ActiveFormatState, type EditorCommandId, isCommandActive } from "../formatting/commands";
import type { FormattingController } from "../types/editorController";

export const TOOL_TRIGGER =
  "inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-md px-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
export interface CommandItem {
  id: EditorCommandId;
  label: string;
  icon: LucideIcon;
}

export function CommandItems({
  items,
  controller,
  active,
}: {
  items: CommandItem[];
  controller?: FormattingController;
  active: ActiveFormatState;
}) {
  return items.map(({ id, label, icon: Icon }) => (
    <DropdownMenuItem
      key={id}
      className="min-h-11"
      disabled={controller?.canRun?.(id) === false}
      onClick={() => {
        controller?.restoreSelection?.();
        controller?.run(id);
      }}
    >
      <Icon className="size-4" />
      {label}
      {isCommandActive(active, id) && (
        <>
          <CheckIcon className="ml-auto size-4" />
          <span className="sr-only">已应用</span>
        </>
      )}
    </DropdownMenuItem>
  ));
}

export function CommandMenu({
  label,
  icon: Icon,
  items,
  controller,
  active,
  children,
  compact = false,
  onReturnFocus,
}: {
  label: string;
  icon: LucideIcon;
  items: CommandItem[];
  controller?: FormattingController;
  active: ActiveFormatState;
  children?: ReactNode;
  compact?: boolean;
  onReturnFocus?: () => void;
}) {
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) controller?.captureSelection?.();
        else controller?.restoreSelection?.();
      }}
    >
      <DropdownMenuTrigger className={cn(TOOL_TRIGGER)} aria-label={label} title={label}>
        <Icon className="size-4" />
        <span className={compact ? "sr-only" : ""}>{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        finalFocus={() => {
          onReturnFocus?.();
          return false;
        }}
      >
        <CommandItems items={items} controller={controller} active={active} />
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
