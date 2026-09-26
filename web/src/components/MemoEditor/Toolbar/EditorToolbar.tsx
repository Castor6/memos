import { Maximize2Icon, Minimize2Icon, MoreHorizontalIcon, RedoIcon, UndoIcon } from "lucide-react";
import { type FC, useRef } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { Location, Visibility } from "@/types/proto/api/v1/memo_service_pb";
import { useTranslate } from "@/utils/i18n";
import { useEditorActiveState, useElementWidth } from "../hooks";
import { validationService } from "../services";
import { useEditorContext, useEditorSelector } from "../state";
import type { EditorToolbarProps } from "../types";
import { CommandMenu } from "./CommandMenu";
import { FormattingToolbar } from "./FormattingToolbar";
import InsertMenu from "./InsertMenu";
import QuickTools from "./QuickTools";
import VisibilitySelector from "./VisibilitySelector";

export const EditorToolbar: FC<EditorToolbarProps> = ({
  controllerRef,
  onInsertReference,
  onSave,
  onCancel,
  memoName,
  onAudioRecorderClick,
}) => {
  const t = useTranslate();
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(rootRef);
  const narrow = width > 0 && width < 560;
  const compact = width > 0 && width < 390;
  const active = useEditorActiveState(controllerRef);
  const isFocusMode = useEditorSelector((s) => s.ui.isFocusMode);
  const { actions, dispatch } = useEditorContext();
  // Subscribe to narrow/derived slices so typing (which only changes content)
  // doesn't re-render the toolbar or the heavy InsertMenu it hosts. `valid`
  // flips only on empty↔non-empty / loading transitions, not per keystroke.
  const valid = useEditorSelector((s) => validationService.canSave(s).valid);
  const isSaving = useEditorSelector((s) => s.ui.isLoading.saving);
  const isUploading = useEditorSelector((s) => s.ui.isLoading.uploading);
  const location = useEditorSelector((s) => s.metadata.location);
  const visibility = useEditorSelector((s) => s.metadata.visibility);

  const handleLocationChange = (next?: Location) => {
    dispatch(actions.setMetadata({ location: next }));
  };

  const handleToggleFocusMode = () => {
    dispatch(actions.toggleFocusMode());
  };

  const handleVisibilityChange = (next: Visibility) => {
    dispatch(actions.setMetadata({ visibility: next }));
  };

  return (
    <div ref={rootRef} className={cn("w-full min-w-0 flex justify-between gap-1 mb-2", narrow ? "flex-col" : "flex-row items-center")}>
      <div className="min-w-0 flex items-center gap-0 py-1 [&>*]:shrink-0" role="toolbar" aria-label="编辑工具">
        <QuickTools controllerRef={controllerRef} compact={width > 0 && width < 310} />
        <FormattingToolbar controllerRef={controllerRef} compact={compact} />
        <InsertMenu
          controllerRef={controllerRef}
          compact={compact}
          onInsertReference={onInsertReference}
          isUploading={isUploading}
          location={location}
          onLocationChange={handleLocationChange}
          onToggleFocusMode={handleToggleFocusMode}
          memoName={memoName}
          onAudioRecorderClick={onAudioRecorderClick}
        />
        <CommandMenu
          onReturnFocus={() => controllerRef.current?.focus()}
          label="更多"
          icon={MoreHorizontalIcon}
          compact={compact}
          controller={controllerRef.current?.formatting}
          active={active}
          items={[
            { id: "undo", label: "撤销", icon: UndoIcon },
            { id: "redo", label: "重做", icon: RedoIcon },
          ]}
        >
          <DropdownMenuSeparator />
          <DropdownMenuItem className="min-h-11" onClick={handleToggleFocusMode}>
            {isFocusMode ? <Minimize2Icon className="size-4" /> : <Maximize2Icon className="size-4" />}
            {isFocusMode ? t("editor.exit-focus-mode") : t("editor.focus-mode")}
          </DropdownMenuItem>
        </CommandMenu>
      </div>

      <div className={cn("shrink-0 flex items-center gap-1", narrow ? "w-full" : "justify-end")}>
        <VisibilitySelector value={visibility} onChange={handleVisibilityChange} />
        {narrow && <span className="flex-1" />}
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={isSaving}>
            {t("common.cancel")}
          </Button>
        )}

        <Button size="sm" onClick={onSave} disabled={!valid || isSaving}>
          {isSaving ? t("editor.saving") : t("editor.save")}
        </Button>
      </div>
    </div>
  );
};
