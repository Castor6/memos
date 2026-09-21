import { useRef, useState } from "react";
import toast from "react-hot-toast";
import { useParams } from "react-router-dom";
import { memoServiceClient } from "@/connect";
import { memoExportFilename } from "@/lib/memo-export";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";

export function useMemoPdfExport(memo: Memo) {
  const { token: shareToken } = useParams();
  const busy = useRef(false);
  const [exporting, setExporting] = useState(false);
  const download = async () => {
    if (busy.current) return;
    busy.current = true;
    setExporting(true);
    const notification = toast.loading("正在生成 PDF…");
    try {
      const options = { timeoutMs: 120_000 };
      const origin = window.location.origin;
      const result = shareToken
        ? await memoServiceClient.exportSharedMemoPdf({ shareToken, origin }, options)
        : await memoServiceClient.exportMemoPdf({ name: memo.name, origin }, options);
      const blob = new Blob([new Uint8Array(result.content)], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = memoExportFilename(memo.name, memo.property?.title || "", "pdf");
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.success("PDF 已生成，正在下载", { id: notification });
    } catch (error) {
      toast.error(
        (item) => (
          <span>
            {error instanceof Error ? error.message : "PDF 生成失败"}
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => {
                toast.dismiss(item.id);
                void download();
              }}
            >
              重试
            </button>
          </span>
        ),
        { id: notification, duration: 10_000 },
      );
    } finally {
      busy.current = false;
      setExporting(false);
    }
  };
  return { exporting, download };
}
