import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { exportMemoMarkdown, memoExportFilename } from "@/lib/memo-export";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";
import { createMemoPdf } from "./memoPdfDocument";
import { createMemoPrintDocument } from "./memoPrintDocument";

export default function MemoExportPdfDialog({ memo, onClose }: { memo: Memo; onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [documentHTML, setDocumentHTML] = useState("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [pdfURL, setPdfURL] = useState("");
  const [attempt, setAttempt] = useState(0);
  const title = memoExportFilename(memo.name, memo.property?.title || "", "pdf").replace(/\.pdf$/, "");

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setReady(false);
    setDocumentHTML("");
    setPdfURL("");
    let objectURL = "";
    createMemoPrintDocument(exportMemoMarkdown(memo.content, window.location.origin), title, controller.signal)
      .then(async (html) => {
        if (controller.signal.aborted) return;
        setDocumentHTML(html);
        const blob = await createMemoPdf(html, controller.signal);
        if (controller.signal.aborted) return;
        objectURL = URL.createObjectURL(blob);
        setPdfURL(objectURL);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "导出失败，请重试");
      });
    return () => {
      controller.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [memo.content, title, attempt]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="full" className="h-[85dvh] max-h-[90dvh] md:max-w-4xl">
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle>导出 PDF</DialogTitle>
          <DialogDescription>导出包含正文图片，文字可选择和复制。文件准备好后，点击保存即可下载 PDF。</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : !documentHTML ? (
          <p role="status">正在准备正文和图片…</p>
        ) : (
          <iframe
            ref={frame}
            title="导出正文预览"
            srcDoc={documentHTML}
            className="min-h-0 h-[60dvh] w-full flex-1 rounded border bg-white"
            onLoad={async () => {
              const doc = frame.current?.contentDocument;
              if (!doc) return;
              try {
                await Promise.all(Array.from(doc.images).map((image) => image.decode()));
                await doc.fonts.ready;
                setReady(true);
              } catch {
                setError("图片解码失败，请重试");
              }
            }}
          />
        )}
        {!error && !pdfURL && (
          <p role="status" className="text-sm text-muted-foreground">
            正在生成 PDF，首次导出需加载中文字体…
          </p>
        )}
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
          {error ? (
            <Button onClick={() => setAttempt((value) => value + 1)}>重试</Button>
          ) : (
            <Button
              disabled={!ready || !pdfURL}
              onClick={() => {
                const anchor = document.createElement("a");
                anchor.href = pdfURL;
                anchor.download = `${title}.pdf`;
                anchor.click();
              }}
            >
              保存 PDF
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
