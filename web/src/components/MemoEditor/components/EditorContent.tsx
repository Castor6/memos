import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { FILE_TITLE } from "@/lib/inline-media";
import { getAttachmentUrl } from "@/utils/attachment";
import Editor from "../Editor";
import { useBlobUrls } from "../hooks";
import { uploadService } from "../services/uploadService";
import { useEditorContext, useEditorSelector } from "../state";
import type { EditorContentProps } from "../types";
import type { LocalFile } from "../types/attachment";
import type { EditorController } from "../types/editorController";

export const EditorContent = forwardRef<EditorController, EditorContentProps>(({ placeholder, onSubmit }, ref) => {
  const { actions, dispatch, getState } = useEditorContext();
  const { createBlobUrl } = useBlobUrls();
  const content = useEditorSelector((s) => s.content);
  const isTodo = useEditorSelector((state) => state.metadata.isTodo);
  const localFiles = useEditorSelector((s) => s.localFiles);
  const isFocusMode = useEditorSelector((s) => s.ui.isFocusMode);
  const editorRef = useRef<EditorController>(null);
  const started = useRef(new Set<string>());
  const uploads = useRef(0);
  const [failed, setFailed] = useState<LocalFile[]>([]);
  useImperativeHandle(ref, () => editorRef.current as EditorController);

  const upload = async (file: LocalFile) => {
    uploads.current++;
    dispatch(actions.setLoading("uploading", true));
    try {
      const [attachment] = await uploadService.uploadFiles([file]);
      editorRef.current?.replaceFile?.(file.previewUrl, getAttachmentUrl(attachment));
      dispatch(actions.setMetadata({ attachments: [...getState().metadata.attachments, attachment] }));
      dispatch(actions.removeLocalFile(file.previewUrl));
      setFailed((previous) => previous.filter((item) => item.previewUrl !== file.previewUrl));
    } catch {
      setFailed((previous) => [...previous.filter((item) => item.previewUrl !== file.previewUrl), file]);
      toast.error(`“${file.file.name}”上传失败，可以重试`);
    } finally {
      uploads.current--;
      dispatch(actions.setLoading("uploading", uploads.current > 0));
    }
  };

  useEffect(() => {
    for (const file of localFiles) {
      if (started.current.has(file.previewUrl)) continue;
      started.current.add(file.previewUrl);
      editorRef.current?.insertFile?.(file.previewUrl, `${FILE_TITLE}${file.file.type || "application/octet-stream"}`, file.file.name);
      void upload(file);
    }
  }, [localFiles]);

  const handleFiles = (files: File[]) => {
    for (const file of files) dispatch(actions.addLocalFile({ file, previewUrl: createBlobUrl(file), origin: "upload" }));
  };

  return (
    <div className="w-full flex flex-col flex-1">
      <Editor
        ref={editorRef}
        className="memo-editor-content"
        initialContent={content || (isTodo ? "- [ ] " : "")}
        placeholder={placeholder || ""}
        isFocusMode={isFocusMode}
        onContentChange={(value) => dispatch(actions.updateContent(value))}
        onFiles={handleFiles}
        onSubmit={onSubmit}
      />
      {failed.map((file) => (
        <div key={file.previewUrl} className="text-sm text-destructive py-2 flex gap-3">
          <button
            type="button"
            onClick={() => {
              setFailed((previous) => previous.filter((item) => item.previewUrl !== file.previewUrl));
              void upload(file);
            }}
          >
            {file.file.name} 上传失败，点击重试
          </button>
          <button
            type="button"
            onClick={() => {
              editorRef.current?.replaceFile?.(file.previewUrl, "");
              dispatch(actions.removeLocalFile(file.previewUrl));
              setFailed((previous) => previous.filter((item) => item.previewUrl !== file.previewUrl));
            }}
          >
            移除
          </button>
        </div>
      ))}
    </div>
  );
});
EditorContent.displayName = "EditorContent";
