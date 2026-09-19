import { create } from "@bufbuild/protobuf";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { instanceServiceClient } from "@/connect";
import useCurrentUser from "@/hooks/useCurrentUser";
import { useSaveWechatKfSetting, useWechatKfSetting, useWechatKfStatus, wechatKfKeys } from "@/hooks/useWechatKf";
import { type WechatKfSetting, WechatKfSettingSchema } from "@/types/proto/api/v1/instance_service_pb";
import { useTranslate } from "@/utils/i18n";
import SettingGroup from "./SettingGroup";
import { SettingList, SettingListItem, SettingPanel } from "./SettingList";
import SettingSection from "./SettingSection";

const splitValues = (value: string) =>
  value
    .split(/[\n,，]/u)
    .map((item) => item.trim())
    .filter(Boolean);
const WechatKfSection = () => {
  const t = useTranslate();
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const setting = useWechatKfSetting();
  const status = useWechatKfStatus();
  const save = useSaveWechatKfSetting();
  const [draft, setDraft] = useState<WechatKfSetting>();
  const [allowed, setAllowed] = useState("");
  const [tags, setTags] = useState("");
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    if (setting.data && !dirty) {
      setDraft(create(WechatKfSettingSchema, { ...setting.data, owner: setting.data.owner || currentUser?.name || "" }));
      setAllowed(setting.data.allowedUsers.join("\n"));
      setTags(setting.data.defaultTags.join(", "));
    }
  }, [setting.data, currentUser?.name, dirty]);
  const update = (change: Partial<WechatKfSetting>) => {
    setDirty(true);
    setDraft((value) => (value ? create(WechatKfSettingSchema, { ...value, ...change }) : value));
  };
  const saveSetting = async () => {
    if (!draft) return;
    try {
      const result = await save.mutateAsync(
        create(WechatKfSettingSchema, { ...draft, allowedUsers: splitValues(allowed), defaultTags: splitValues(tags) }),
      );
      setDraft(result);
      setDirty(false);
      toast.success(t("setting.wechat-kf.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("setting.wechat-kf.save-error"));
    }
  };
  const testConnection = async () => {
    setTesting(true);
    try {
      await instanceServiceClient.testWechatKfSetting({});
      toast.success(t("setting.wechat-kf.test-success"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("setting.wechat-kf.test-error"));
    } finally {
      setTesting(false);
    }
  };
  const stateName = (state: string) =>
    ({
      pending: t("setting.wechat-kf.pending"),
      done: t("setting.wechat-kf.done"),
      failed: t("setting.wechat-kf.failed"),
      sent: t("setting.wechat-kf.sent"),
      unknown: t("setting.wechat-kf.unknown"),
      expired: t("setting.wechat-kf.expired"),
      delivery_failed: t("setting.wechat-kf.delivery-failed"),
      cancelled: t("setting.wechat-kf.cancelled"),
      sending: t("setting.wechat-kf.sending"),
    })[state] || state;
  const secretPlaceholder = (configured: boolean) =>
    configured ? t("setting.wechat-kf.secret-retained") : t("setting.wechat-kf.secret-empty");
  return (
    <SettingSection title={t("setting.wechat-kf.title")} description={t("setting.wechat-kf.description")}>
      {setting.isError ? <p className="text-sm text-destructive">{t("setting.wechat-kf.load-error")}</p> : null}
      {!draft && setting.isLoading ? <p className="text-sm text-muted-foreground">…</p> : null}
      {draft ? (
        <>
          <SettingGroup title={t("setting.wechat-kf.connection")}>
            <SettingList>
              <SettingListItem label={t("setting.wechat-kf.enabled")} description={t("setting.wechat-kf.enabled-description")}>
                <Switch
                  aria-label={t("setting.wechat-kf.enabled")}
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => update({ enabled })}
                />
              </SettingListItem>
              <SettingListItem label={t("setting.wechat-kf.owner")}>
                <span className="text-sm break-all">
                  {draft.owner.replace(/^users\//u, "")} · {draft.space || t("setting.wechat-kf.personal")}
                </span>
              </SettingListItem>
              <SettingListItem label={t("setting.wechat-kf.corp-id")} controlClassName="w-full sm:w-80">
                <Input
                  aria-label={t("setting.wechat-kf.corp-id")}
                  value={draft.corpId}
                  onChange={(e) => update({ corpId: e.target.value })}
                  autoComplete="off"
                />
              </SettingListItem>
              <SettingListItem label={t("setting.wechat-kf.kf-id")} controlClassName="w-full sm:w-80">
                <Input
                  aria-label={t("setting.wechat-kf.kf-id")}
                  value={draft.kfId}
                  onChange={(e) => update({ kfId: e.target.value })}
                  autoComplete="off"
                />
              </SettingListItem>
              <SettingListItem label="Secret" controlClassName="w-full sm:w-80">
                <Input
                  aria-label="Secret"
                  type="password"
                  value={draft.secret}
                  onChange={(e) => update({ secret: e.target.value })}
                  placeholder={secretPlaceholder(draft.secretSet)}
                  autoComplete="new-password"
                />
              </SettingListItem>
              <SettingListItem label={t("setting.wechat-kf.callback-token")} controlClassName="w-full sm:w-80">
                <Input
                  aria-label={t("setting.wechat-kf.callback-token")}
                  type="password"
                  value={draft.callbackToken}
                  onChange={(e) => update({ callbackToken: e.target.value })}
                  placeholder={secretPlaceholder(draft.callbackTokenSet)}
                  autoComplete="new-password"
                />
              </SettingListItem>
              <SettingListItem label="EncodingAESKey" controlClassName="w-full sm:w-80">
                <Input
                  aria-label="EncodingAESKey"
                  type="password"
                  value={draft.encodingAesKey}
                  onChange={(e) => update({ encodingAesKey: e.target.value })}
                  placeholder={secretPlaceholder(draft.encodingAesKeySet)}
                  autoComplete="new-password"
                />
              </SettingListItem>
              <SettingListItem label={t("setting.wechat-kf.callback")} controlClassName="w-full sm:w-80">
                <code className="text-xs break-all">
                  {window.location.origin}
                  {draft.callbackPath}
                </code>
              </SettingListItem>
              <SettingListItem
                label={t("setting.wechat-kf.allowed-users")}
                description={t("setting.wechat-kf.allowed-description")}
                controlClassName="w-full sm:w-80"
              >
                <Textarea
                  aria-label={t("setting.wechat-kf.allowed-users")}
                  value={allowed}
                  onChange={(e) => {
                    setDirty(true);
                    setAllowed(e.target.value);
                  }}
                  rows={3}
                  autoComplete="off"
                />
              </SettingListItem>
            </SettingList>
          </SettingGroup>
          <SettingGroup title={t("setting.wechat-kf.clipping")} showSeparator>
            <SettingList>
              <SettingListItem label={t("setting.wechat-kf.default-tags")} controlClassName="w-full sm:w-80">
                <Input
                  aria-label={t("setting.wechat-kf.default-tags")}
                  value={tags}
                  onChange={(e) => {
                    setDirty(true);
                    setTags(e.target.value);
                  }}
                />
              </SettingListItem>
              <SettingListItem label={t("setting.wechat-kf.chat-tag")} controlClassName="w-full sm:w-80">
                <Input
                  aria-label={t("setting.wechat-kf.chat-tag")}
                  value={draft.chatTag}
                  onChange={(e) => update({ chatTag: e.target.value })}
                />
              </SettingListItem>
              <SettingListItem label={t("setting.wechat-kf.media-limit")} controlClassName="w-full sm:w-80">
                <Input
                  aria-label={t("setting.wechat-kf.media-limit")}
                  type="number"
                  min={1}
                  max={100}
                  value={draft.maxMediaMb}
                  onChange={(e) => update({ maxMediaMb: Number(e.target.value) })}
                />
              </SettingListItem>
              <SettingListItem label={t("setting.wechat-kf.receipts")} description={t("setting.wechat-kf.receipts-description")}>
                <Switch
                  aria-label={t("setting.wechat-kf.receipts")}
                  checked={draft.receiptsEnabled}
                  onCheckedChange={(receiptsEnabled) => update({ receiptsEnabled })}
                />
              </SettingListItem>
            </SettingList>
            <div className="flex flex-wrap gap-2 pt-4">
              <Button disabled={!dirty || save.isPending} onClick={() => void saveSetting()}>
                {t("setting.wechat-kf.save")}
              </Button>
              <Button variant="outline" disabled={dirty || testing || !draft.secretSet} onClick={() => void testConnection()}>
                {t("setting.wechat-kf.test")}
              </Button>
            </div>
          </SettingGroup>
        </>
      ) : null}
      <SettingGroup title={t("setting.wechat-kf.results")} showSeparator>
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 text-sm">
          <span>{status.data?.consumerActive ? t("setting.wechat-kf.running") : t("setting.wechat-kf.stopped")}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={status.isFetching}
            onClick={() => void queryClient.invalidateQueries({ queryKey: wechatKfKeys.status })}
          >
            {t("setting.wechat-kf.refresh")}
          </Button>
        </div>
        {status.isError ? <p className="text-sm text-destructive">{t("setting.wechat-kf.load-error")}</p> : null}
        {status.data?.syncError ? <p className="mb-3 break-words text-sm text-destructive">{status.data.syncError}</p> : null}
        {status.data ? (
          <>
            <p className="mb-2 text-sm text-muted-foreground">
              {t("setting.wechat-kf.jobs")}:{" "}
              {Object.entries(status.data.jobs)
                .map(([key, value]) => `${stateName(key)} ${value}`)
                .join(" · ") || "0"}
            </p>
            <p className="mb-3 text-sm text-muted-foreground">
              {t("setting.wechat-kf.replies")}:{" "}
              {Object.entries(status.data.replies)
                .map(([key, value]) => `${stateName(key)} ${value}`)
                .join(" · ") || "0"}
            </p>
            <SettingPanel>
              {status.data.recentResults.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">{t("setting.wechat-kf.empty")}</p>
              ) : (
                status.data.recentResults.map((result, index) => (
                  <div key={`${result.createdTime}-${index}`} className="space-y-1 border-b border-border px-3 py-3 last:border-0">
                    <div className="flex flex-wrap justify-between gap-2 text-sm">
                      <span>
                        {result.type} · {stateName(result.state)}
                      </span>
                      <time className="text-xs text-muted-foreground">{new Date(Number(result.createdTime) * 1000).toLocaleString()}</time>
                    </div>
                    {result.error ? (
                      <p className="break-words text-sm text-destructive">
                        {result.error} · {t("setting.wechat-kf.attempts", { count: result.attempts })}
                      </p>
                    ) : null}
                  </div>
                ))
              )}
            </SettingPanel>
          </>
        ) : null}
      </SettingGroup>
    </SettingSection>
  );
};
export default WechatKfSection;
