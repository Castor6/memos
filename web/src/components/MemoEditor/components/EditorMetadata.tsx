import { LocationDisplayEditor } from "@/components/MemoMetadata";
import { useEditorContext, useEditorSelector } from "../state";
import type { EditorMetadataProps } from "../types";
export const EditorMetadata = (_props: EditorMetadataProps) => {
  const { actions, dispatch } = useEditorContext();
  const location = useEditorSelector((s) => s.metadata.location);
  return location ? (
    <LocationDisplayEditor location={location} onRemove={() => dispatch(actions.setMetadata({ location: undefined }))} />
  ) : null;
};
