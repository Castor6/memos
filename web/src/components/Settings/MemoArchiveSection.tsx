import { DownloadIcon, UploadIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";
import { MAX_MEMO_ARCHIVE_BYTES, useExportMemoArchive, useImportMemoArchive } from "@/hooks/useMemoArchive";
import { downloadMemoArchive } from "@/lib/memo-archive";
import type { ImportMemoArchiveResponse } from "@/types/proto/api/v1/memo_transfer_service_pb";
import { useTranslate } from "@/utils/i18n";
import SettingGroup from "./SettingGroup";
import { SettingPanel } from "./SettingList";
import SettingSection from "./SettingSection";

const ResultMessages = ({ title, messages }: { title: string; messages: string[] }) =>
  messages.length > 0 ? (
    <div className="space-y-1">
      <p className="font-medium">{title}</p>
      <ul className="list-disc space-y-1 pl-5">
        {messages.map((message, index) => (
          <li key={`${index}:${message}`} className="break-words">
            {message}
          </li>
        ))}
      </ul>
    </div>
  ) : null;

const MemoArchiveSection = () => {
  const t = useTranslate();
  const { refetchSettings } = useAuth();
  const exportArchive = useExportMemoArchive();
  const importArchive = useImportMemoArchive();
  const inputID = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [fileError, setFileError] = useState("");
  const [error, setError] = useState("");
  const [exportResult, setExportResult] = useState<{ memoCount: number; attachmentCount: number; warnings: string[] }>();
  const [importResult, setImportResult] = useState<ImportMemoArchiveResponse>();
  const busy = exportArchive.isPending || importArchive.isPending;

  const handleExport = async () => {
    setError("");
    setExportResult(undefined);
    try {
      const result = await exportArchive.mutateAsync();
      downloadMemoArchive(result.content, result.filename);
      setExportResult({ memoCount: result.memoCount, attachmentCount: result.attachmentCount, warnings: result.warnings });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("setting.memo-archive.export-error"));
    } finally {
      exportArchive.reset();
    }
  };

  const handleImport = async () => {
    if (!file || fileError) return;
    setError("");
    setImportResult(undefined);
    try {
      const result = await importArchive.mutateAsync(file);
      setImportResult(result);
      setFile(undefined);
      if (inputRef.current) inputRef.current.value = "";
      void refetchSettings().catch(() => toast.error(t("setting.memo-archive.settings-refresh-error")));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("setting.memo-archive.import-error"));
    } finally {
      importArchive.reset();
    }
  };

  return (
    <SettingSection title={t("setting.memo-archive.label")} description={t("setting.memo-archive.description")}>
      <SettingGroup title={t("setting.memo-archive.export-title")} description={t("setting.memo-archive.export-description")}>
        <div>
          <Button variant="outline" disabled={busy} onClick={() => void handleExport()}>
            <DownloadIcon className="size-4" />
            {exportArchive.isPending ? t("setting.memo-archive.exporting") : t("setting.memo-archive.export")}
          </Button>
        </div>
        {exportResult && (
          <SettingPanel>
            <div className="space-y-3 p-3 text-sm" role="status">
              <p>{t("setting.memo-archive.export-result", { memos: exportResult.memoCount, attachments: exportResult.attachmentCount })}</p>
              <ResultMessages title={t("setting.memo-archive.warnings")} messages={exportResult.warnings} />
            </div>
          </SettingPanel>
        )}
      </SettingGroup>
      <SettingGroup showSeparator title={t("setting.memo-archive.import-title")} description={t("setting.memo-archive.import-description")}>
        <p className="text-sm leading-6 text-muted-foreground">{t("setting.memo-archive.import-spaces")}</p>
        <div className="space-y-2">
          <label htmlFor={inputID} className="text-sm font-medium">
            {t("setting.memo-archive.choose-file")}
          </label>
          <Input
            id={inputID}
            ref={inputRef}
            type="file"
            accept=".zip,application/zip"
            disabled={busy}
            onChange={(event) => {
              const selected = event.target.files?.[0];
              setFile(selected);
              setImportResult(undefined);
              setError("");
              setFileError(
                selected && (!selected.name.toLowerCase().endsWith(".zip") || selected.size === 0 || selected.size > MAX_MEMO_ARCHIVE_BYTES)
                  ? t("setting.memo-archive.invalid-file")
                  : "",
              );
            }}
          />
          {fileError && (
            <p role="alert" className="text-sm text-destructive">
              {fileError}
            </p>
          )}
        </div>
        <div>
          <Button disabled={busy || !file || Boolean(fileError)} onClick={() => void handleImport()}>
            <UploadIcon className="size-4" />
            {importArchive.isPending ? t("setting.memo-archive.importing") : t("setting.memo-archive.import")}
          </Button>
        </div>
        {importResult && (
          <SettingPanel>
            <div className="space-y-3 p-3 text-sm" role="status">
              <p className="font-medium">
                {importResult.errors.length ? t("setting.memo-archive.partial-result") : t("setting.memo-archive.import-complete")}
              </p>
              <p>
                {t("setting.memo-archive.import-result", {
                  imported: importResult.imported,
                  skipped: importResult.skipped,
                  attachments: importResult.attachments,
                })}
              </p>
              <ResultMessages title={t("setting.memo-archive.errors")} messages={importResult.errors} />
              <ResultMessages title={t("setting.memo-archive.warnings")} messages={importResult.warnings} />
            </div>
          </SettingPanel>
        )}
      </SettingGroup>
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
    </SettingSection>
  );
};

export default MemoArchiveSection;
