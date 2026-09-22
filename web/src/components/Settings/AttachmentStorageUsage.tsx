import useCurrentUser from "@/hooks/useCurrentUser";
import { useUserStats } from "@/hooks/useUserQueries";
import { formatFileSize } from "@/utils/format";
import { useTranslate } from "@/utils/i18n";
import SettingGroup from "./SettingGroup";

const AttachmentStorageUsage = () => {
  const t = useTranslate();
  const user = useCurrentUser();
  const { data, isPending, isError, refetch } = useUserStats(user?.name);
  const size = data?.attachmentStorageBytes;
  return (
    <SettingGroup title={t("setting.account.attachment-storage")} description={t("setting.account.attachment-storage-description")}>
      {isError ? (
        <button type="button" className="self-start text-sm text-destructive underline" onClick={() => void refetch()}>
          {t("setting.account.attachment-storage-retry")}
        </button>
      ) : (
        <p className="text-2xl font-semibold tabular-nums" aria-live="polite">
          {isPending || size === undefined ? "—" : formatFileSize(Number(size))}
        </p>
      )}
    </SettingGroup>
  );
};

export default AttachmentStorageUsage;
