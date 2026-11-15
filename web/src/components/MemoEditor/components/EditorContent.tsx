import { LoaderCircleIcon, XIcon } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import MemoImageGrid from "@/components/MemoView/components/MemoImageGrid";
import { useAuth } from "@/contexts/AuthContext";
import { FILE_TITLE } from "@/lib/inline-media";
import { hasImageGridTag } from "@/lib/tag";
import { getAttachmentThumbnailUrl, getAttachmentUrl, isImage } from "@/utils/attachment";
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
  const isSaving = useEditorSelector((s) => s.ui.isLoading.saving);
  const isTodo = useEditorSelector((state) => state.metadata.isTodo);
  const localFiles = useEditorSelector((s) => s.localFiles);
  const isFocusMode = useEditorSelector((s) => s.ui.isFocusMode);
  const tags = useEditorSelector((s) => s.metadata.tags);
  const attachments = useEditorSelector((s) => s.metadata.attachments);
  const gridAttachments = useEditorSelector((s) => s.metadata.gridAttachments);
  const { userTagsSetting } = useAuth();
  const imageGrid = hasImageGridTag(tags, userTagsSetting);
  // Local preview URLs of uploads that go to the bottom grid rather than the body.
  const [detached, setDetached] = useState<Set<string>>(() => new Set());
  const detachedRef = useRef(detached);
  detachedRef.current = detached;
  // Selection order of bottom-grid images, keyed by preview URL and then by attachment name,
  // so concurrent uploads keep the order the user picked them in.
  const gridOrder = useRef(new Map<string, number>());
  const orderOf = (key: string) => gridOrder.current.get(key) ?? -1;
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
      const { metadata } = getState();
      if (detachedRef.current.has(file.previewUrl)) {
        dispatch(
          actions.setMetadata({
            attachments: [...metadata.attachments, attachment],
            gridAttachments: insertByOrder(metadata.gridAttachments ?? [], attachment.name, file.previewUrl),
          }),
        );
        forgetDetached(file.previewUrl);
      } else {
        editorRef.current?.replaceFile?.(file.previewUrl, getAttachmentUrl(attachment));
        dispatch(actions.setMetadata({ attachments: [...metadata.attachments, attachment] }));
      }
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
      if (imageGrid && isImage(file.file.type)) {
        gridOrder.current.set(file.previewUrl, gridOrder.current.size);
        detachedRef.current = new Set(detachedRef.current).add(file.previewUrl);
        setDetached(detachedRef.current);
      } else {
        editorRef.current?.insertFile?.(file.previewUrl, `${FILE_TITLE}${file.file.type || "application/octet-stream"}`, file.file.name);
      }
      void upload(file);
    }
  }, [localFiles]);

  const insertByOrder = (names: string[], name: string, previewUrl: string) => {
    const order = orderOf(previewUrl);
    gridOrder.current.set(name, order);
    const index = names.findIndex((item) => orderOf(item) > order);
    return index < 0 ? [...names, name] : [...names.slice(0, index), name, ...names.slice(index)];
  };

  const forgetDetached = (previewUrl: string) => {
    if (!detachedRef.current.has(previewUrl)) return;
    const next = new Set(detachedRef.current);
    next.delete(previewUrl);
    detachedRef.current = next;
    setDetached(next);
  };

  const removeGridAttachment = (name: string) => {
    const { metadata } = getState();
    dispatch(
      actions.setMetadata({
        attachments: metadata.attachments.filter((attachment) => attachment.name !== name),
        gridAttachments: (metadata.gridAttachments ?? []).filter((item) => item !== name),
      }),
    );
  };

  const gridItems = [
    ...(gridAttachments ?? []).flatMap((name) => {
      const attachment = attachments.find((item) => item.name === name);
      return attachment
        ? [
            {
              key: name,
              thumbnail: getAttachmentThumbnailUrl(attachment),
              alt: attachment.filename,
              pending: false,
              remove: () => removeGridAttachment(name),
            },
          ]
        : [];
    }),
    ...localFiles
      .filter((file) => detached.has(file.previewUrl))
      .map((file) => ({ key: file.previewUrl, thumbnail: file.previewUrl, alt: file.file.name, pending: true, remove: () => undefined })),
  ].sort((a, b) => orderOf(a.key) - orderOf(b.key));

  const handleFiles = (files: File[]) => {
    for (const file of files) dispatch(actions.addLocalFile({ file, previewUrl: createBlobUrl(file), origin: "upload" }));
  };

  return (
    <div className="w-full flex flex-col flex-1">
      <Editor
        ref={editorRef}
        className="memo-editor-content"
        initialContent={content || (isTodo ? "- [ ] " : "")}
        readOnly={isSaving}
        placeholder={placeholder || ""}
        isFocusMode={isFocusMode}
        onContentChange={(value) => dispatch(actions.updateContent(value))}
        onFiles={handleFiles}
        onSubmit={onSubmit}
      />
      {gridItems.length > 0 && (
        <MemoImageGrid
          className="mt-2"
          images={gridItems}
          renderOverlay={(index) => {
            const item = gridItems[index];
            if (item.pending)
              return (
                <span className="absolute inset-0 flex items-center justify-center bg-background/40" aria-label="上传中">
                  <LoaderCircleIcon className="size-5 animate-spin text-foreground" />
                </span>
              );
            return (
              <button
                type="button"
                className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-background/85 text-foreground shadow-sm hover:bg-background"
                aria-label={`移除图片 ${item.alt}`}
                disabled={isSaving}
                onClick={item.remove}
              >
                <XIcon className="size-3.5" />
              </button>
            );
          }}
        />
      )}
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
              forgetDetached(file.previewUrl);
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
