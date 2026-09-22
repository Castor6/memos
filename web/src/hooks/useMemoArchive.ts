import { useMutation, useQueryClient } from "@tanstack/react-query";
import { memoTransferServiceClient } from "@/connect";
import { attachmentKeys } from "@/hooks/useAttachmentQueries";
import { memoKeys } from "@/hooks/useMemoQueries";
import { userKeys } from "@/hooks/useUserQueries";

export const MAX_MEMO_ARCHIVE_BYTES = 128 * 1024 * 1024;

export function useExportMemoArchive() {
  return useMutation({
    mutationFn: () => memoTransferServiceClient.exportMemoArchive({}),
    retry: false,
    gcTime: 0,
  });
}

export function useImportMemoArchive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      if (file.size === 0 || file.size > MAX_MEMO_ARCHIVE_BYTES) throw new Error("Archive must be between 1 byte and 128 MiB");
      return memoTransferServiceClient.importMemoArchive({ content: new Uint8Array(await file.arrayBuffer()) });
    },
    retry: false,
    gcTime: 0,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: memoKeys.all });
      void queryClient.invalidateQueries({ queryKey: attachmentKeys.all });
      void queryClient.invalidateQueries({ queryKey: userKeys.all });
    },
  });
}
