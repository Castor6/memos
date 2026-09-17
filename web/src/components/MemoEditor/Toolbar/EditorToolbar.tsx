import type { FC } from "react";
import { Button } from "@/components/ui/button";
import type { Location, Visibility } from "@/types/proto/api/v1/memo_service_pb";
import { useTranslate } from "@/utils/i18n";
import { validationService } from "../services";
import { useEditorContext, useEditorSelector } from "../state";
import type { EditorToolbarProps } from "../types";
import InsertMenu from "./InsertMenu";
import VisibilitySelector from "./VisibilitySelector";

export const EditorToolbar: FC<EditorToolbarProps> = ({
  formattingTools,
  onInsertReference,
  onSave,
  onCancel,
  memoName,
  onAudioRecorderClick,
}) => {
  const t = useTranslate();
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
    <div className="w-full min-w-0 flex flex-row justify-between items-center gap-2 mb-2">
      <div className="min-w-0 flex flex-row items-center gap-1 overflow-x-auto py-1 [&>*]:shrink-0">
        <InsertMenu
          onInsertReference={onInsertReference}
          isUploading={isUploading}
          location={location}
          onLocationChange={handleLocationChange}
          onToggleFocusMode={handleToggleFocusMode}
          memoName={memoName}
          onAudioRecorderClick={onAudioRecorderClick}
        />
        {formattingTools}
        <VisibilitySelector value={visibility} onChange={handleVisibilityChange} />
      </div>

      <div className="shrink-0 flex flex-row justify-end items-center gap-1">
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
