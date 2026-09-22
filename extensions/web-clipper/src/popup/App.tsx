import { Tooltip } from "@base-ui/react/tooltip";
import {
  CheckCircle2Icon,
  EarthIcon,
  ExternalLinkIcon,
  GlobeIcon,
  HistoryIcon,
  LockIcon,
  SettingsIcon,
  TriangleAlertIcon,
  UsersRoundIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import browser from "webextension-polyfill";
import { AccountBadge } from "@/components/account-badge";
import { AppBrand } from "@/components/app-brand";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { describeSaveError, type SaveErrorDetail } from "@/lib/errors";
import { formatDateTime, t, tp } from "@/lib/i18n";
import type { Visibility } from "@/lib/memos-client";
import type { PopupIdentity, PopupState } from "@/lib/popup-state";
import { useClipper } from "./use-clipper";
import { usePopupState } from "./use-popup-state";

const SAVED_AT_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};
const SAVED_CONFIRMATION_MS = 1_400;

function openOptions() {
  void browser.runtime.openOptionsPage();
}

function openHistory() {
  void browser.tabs.create({ url: browser.runtime.getURL("src/options/index.html?view=history") });
}

function HeaderActionTooltip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side="bottom" sideOffset={6} className="z-50">
          <Tooltip.Popup
            role="tooltip"
            className="max-w-56 rounded-md bg-foreground px-2 py-1 text-center text-[11px] font-medium leading-4 text-background shadow-sm transition-opacity duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0"
          >
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/**
 * Slim toolbar shared by every popup view: identity on the left, quick links on the right —
 * the user's instance (when connected) and the options page.
 */
function Header({ left, instanceUrl }: { left: React.ReactNode; instanceUrl?: string | null }) {
  return (
    <header className="flex h-11 shrink-0 items-center justify-between border-b pe-2 ps-3">
      <div className="min-w-0">{left}</div>
      <Tooltip.Provider delay={400}>
        <div className="flex shrink-0 items-center gap-0.5">
          {instanceUrl ? (
            <HeaderActionTooltip label={t("popupOpenInstance")}>
              <a
                className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
                href={instanceUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={t("popupOpenInstance")}
              >
                <GlobeIcon />
              </a>
            </HeaderActionTooltip>
          ) : null}
          <HeaderActionTooltip label={t("popupOpenHistory")}>
            <Button variant="ghost" size="icon-sm" onClick={() => openHistory()} aria-label={t("popupOpenHistory")}>
              <HistoryIcon />
            </Button>
          </HeaderActionTooltip>
          <HeaderActionTooltip label={t("popupExtensionSettings")}>
            <Button variant="ghost" size="icon-sm" onClick={openOptions} aria-label={t("popupExtensionSettings")}>
              <SettingsIcon />
            </Button>
          </HeaderActionTooltip>
        </div>
      </Tooltip.Provider>
    </header>
  );
}

function IdentityBadge({ identity }: { identity: PopupIdentity }) {
  return <AccountBadge compact identity={identity} />;
}

// Fills the fixed popup size (set in index.html) so every view has identical dimensions.
function Frame({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full w-full flex-col bg-background text-foreground">{children}</div>;
}

function GatePrompt({
  title,
  body,
  learnMore,
  instanceUrl,
  identity,
}: {
  title?: string;
  body: string;
  learnMore?: { label: string; url: string };
  instanceUrl?: string | null;
  identity?: PopupIdentity;
}) {
  return (
    <Frame>
      <Header left={identity ? <IdentityBadge identity={identity} /> : <AppBrand />} instanceUrl={instanceUrl} />
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        {title ? <p className="text-sm font-medium">{title}</p> : null}
        <p className="text-sm text-muted-foreground">{body}</p>
        {learnMore ? (
          <a
            href={learnMore.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {learnMore.label}
            <ExternalLinkIcon className="h-3.5 w-3.5" />
          </a>
        ) : null}
        <Button className="mt-2 w-full" onClick={openOptions}>
          {t("commonOpenSettings")}
        </Button>
      </div>
    </Frame>
  );
}

/**
 * Persistent in-popup failure state: title + why + the fix as a button, not prose. A toast
 * auto-dismisses — wrong for an error that needs reading and action. Retry reuses the intact
 * editor content; the bar clears when the user edits or a retry succeeds.
 */
function ErrorBar({ error, busy, onRetry }: { error: SaveErrorDetail; busy: boolean; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>{error.title}</AlertTitle>
      <AlertDescription>
        {error.why} {error.howToFix[0]}
        {error.learnMore ? (
          <>
            {" "}
            <a href={error.learnMore.url} target="_blank" rel="noreferrer" className="font-medium">
              {error.learnMore.label}
            </a>
          </>
        ) : null}
      </AlertDescription>
      <div className="col-start-2 mt-2 flex items-center gap-2">
        {error.primaryAction === "settings" && (
          <Button size="xs" onClick={openOptions}>
            {t("commonOpenSettings")}
          </Button>
        )}
        <Button size="xs" variant={error.primaryAction === "settings" ? "ghost" : "default"} disabled={busy} onClick={onRetry}>
          {busy ? t("commonRetrying") : t("commonTryAgain")}
        </Button>
      </div>
    </Alert>
  );
}

type ClipperState = ReturnType<typeof useClipper>;
type ReadyPopupState = Extract<PopupState, { status: "ready" }>;
type BlockedPopupState = Exclude<PopupState, { status: "ready" }>;

function ReconciliationBar({ state }: { state: BlockedPopupState }) {
  const signedOut = state.status === "signed-out";
  return (
    <Alert>
      <AlertTitle>
        {signedOut ? t("popupSignedOut") : state.status === "disconnected" ? t("popupDisconnected") : t("popupNeedsUpgrade")}
      </AlertTitle>
      <AlertDescription>{t("popupDraftPreserved")}</AlertDescription>
      <Button size="xs" className="mt-2 w-fit" onClick={openOptions}>
        {t("commonOpenSettings")}
      </Button>
    </Alert>
  );
}

function SignedInView({ c, state, blocked }: { c: ClipperState; state: ReadyPopupState; blocked?: BlockedPopupState }) {
  const [error, setError] = useState<SaveErrorDetail | null>(null);
  const [saved, setSaved] = useState(false);
  const [failedImages, setFailedImages] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const draft = c.draft;
  const isPickup = draft?.capture.kind === "PICK_UP";
  const disabled = c.busy || c.extracting || !!blocked;
  const editingDisabled = disabled || c.awaitingConfirmation;
  const onSave = async () => {
    setSaved(false);
    setFailedImages(0);
    const result = await c.save();
    if (result.ok) {
      setError(null);
      setSaved(true);
      setFailedImages(result.failedImages ?? 0);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaved(false), SAVED_CONFIRMATION_MS);
    } else setError(describeSaveError(result.errorKind, state.source));
  };
  const edit = (change: Parameters<ClipperState["update"]>[0], fields?: Parameters<ClipperState["update"]>[1]) => {
    setSaved(false);
    setError(null);
    c.update(change, fields);
  };
  const visibilityItems = { PRIVATE: t("commonPrivate"), PROTECTED: t("commonProtected"), PUBLIC: t("commonPublic") };
  const visibilityIcons = { PRIVATE: LockIcon, PROTECTED: UsersRoundIcon, PUBLIC: EarthIcon };
  const VisibilityIcon = visibilityIcons[draft?.visibility ?? "PRIVATE"];
  return (
    <Frame>
      <Header left={<IdentityBadge identity={state.identity} />} instanceUrl={state.instanceUrl} />
      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <fieldset className="grid grid-cols-2 gap-2" aria-label="保存方式">
          <Button
            variant={draft?.capture.kind === "STAR" ? "default" : "outline"}
            disabled={!c.ready || disabled}
            onClick={() => {
              setError(null);
              setSaved(false);
              void c.start("STAR");
            }}
          >
            Star
          </Button>
          <Button
            variant={isPickup ? "default" : "outline"}
            disabled={!c.ready || disabled}
            onClick={() => {
              setError(null);
              setSaved(false);
              void c.start("PICK_UP");
            }}
          >
            Pick up
          </Button>
        </fieldset>
        {!draft && !c.extracting ? (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-4 text-sm">
            <p>
              <strong>Star</strong> · 剪藏当前网页，记下你的思考。
            </p>
            <p>
              <strong>Pick up</strong> · 打开你在 x.com 的回复详情，留存评论与回应内容。
            </p>
            <p className="text-xs text-muted-foreground">点击后才提取正文。已保存记录同步到你的 Memos，未保存草稿留在当前浏览器。</p>
          </div>
        ) : null}
        {c.extracting ? (
          <p role="status" className="flex items-center gap-2 text-sm">
            <Spinner />
            正在提取页面…
          </p>
        ) : null}
        {c.notice ? (
          <p role="alert" className="text-sm text-destructive">
            {c.notice}
          </p>
        ) : null}
        {c.storageError ? (
          <p role="alert" className="text-sm text-destructive">
            {c.storageError}
          </p>
        ) : null}
        {blocked ? <ReconciliationBar state={blocked} /> : null}
        {c.capabilityError ? (
          <div role="alert" className="space-y-2 text-xs text-destructive">
            <p>{c.capabilityError}</p>
            <Button size="xs" variant="outline" onClick={c.retryCapabilities}>
              重试连接
            </Button>
          </div>
        ) : c.capabilities && !c.capabilities.supported ? (
          <p role="alert" className="text-xs text-destructive">
            当前服务器尚不支持 Star / Pick up 记录同步，请先升级 Memos。草稿已留在本地。
          </p>
        ) : null}
        {draft ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <a
                href={draft.capture.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate text-xs text-muted-foreground underline"
                title={draft.title}
              >
                {draft.title || draft.capture.sourceUrl}
              </a>
              <Button size="xs" variant="ghost" disabled={editingDisabled} onClick={() => void c.start(draft.capture.kind, true)}>
                重新提取原内容
              </Button>
            </div>
            <label htmlFor="capture-comment" className="flex flex-col gap-1.5 text-sm font-medium">
              {isPickup ? "我的评论" : "我的思考"}
              <Textarea
                id="capture-comment"
                aria-label={isPickup ? "我的评论" : "我的思考"}
                value={draft.capture.comment}
                readOnly={isPickup}
                disabled={editingDisabled}
                className="min-h-24 max-h-48 resize-y text-sm field-sizing-fixed"
                placeholder="什么吸引了你？你认同、质疑或联想到了什么？"
                onChange={(event) => edit({}, { comment: event.target.value })}
              />
            </label>
            {isPickup ? (
              <>
                <p className="text-[11px] text-muted-foreground">保留已发表的原话；新的想法写在下方。</p>
                {!draft.confirmed ? (
                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={draft.confirmed}
                      disabled={editingDisabled}
                      onChange={(event) => edit({ confirmed: event.target.checked })}
                    />
                    页面未能确认登录身份，我确认上方评论由我发表。
                  </label>
                ) : null}
                <label htmlFor="capture-context" className="flex flex-col gap-1.5 text-sm font-medium">
                  补充背景（可选）
                  <Textarea
                    id="capture-context"
                    aria-label="补充背景"
                    value={draft.capture.context}
                    disabled={editingDisabled}
                    className="min-h-20 max-h-40 resize-y text-sm field-sizing-fixed"
                    placeholder="当时为什么回复？有什么背景、链接或后来的感想？"
                    onChange={(event) => edit({}, { context: event.target.value })}
                  />
                </label>
              </>
            ) : null}
            {draft.warnings.length ? (
              <ul className="list-inside list-disc space-y-1 text-xs text-amber-700 dark:text-amber-400">
                {draft.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            <details className="rounded-md border p-2">
              <summary className="cursor-pointer text-sm font-medium">{isPickup ? "回应内容与上文" : "原内容"} · 点击展开</summary>
              <Textarea
                aria-label="原内容"
                className="mt-2 min-h-40 max-h-64 resize-y text-xs field-sizing-fixed"
                value={draft.original}
                disabled={editingDisabled}
                onChange={(event) => edit({ original: event.target.value })}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">可编辑保存的正文；Pick up 的原始互动快照另行保留。</p>
            </details>
            <details className="rounded-md border p-2">
              <summary className="cursor-pointer text-xs">预览完整保存内容</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{c.content}</pre>
            </details>
            {draft.images.length ? <p className="text-xs text-muted-foreground">{draft.images.length} 张图片将尝试保存为附件。</p> : null}
            <p role={c.overLimit ? "alert" : "status"} className={`text-xs ${c.overLimit ? "text-destructive" : "text-muted-foreground"}`}>
              正文 {c.contentBytes.toLocaleString()} 字节
              {c.capabilities ? ` / 上限 ${c.capabilities.contentMaxBytes.toLocaleString()} 字节` : " · 正在读取服务器限制…"}
              {c.overLimit ? "。已超限，请精简原内容，或在 Memos 实例设置中调整正文上限。草稿会保留。" : ""}
            </p>
            {c.statusError ? (
              <p role="status" className="text-xs text-muted-foreground">
                {c.statusError}
              </p>
            ) : null}
            {c.savedClip ? (
              <p role="status" className="text-xs text-muted-foreground">
                {t("popupSavedAt", formatDateTime(c.savedClip.savedAt, SAVED_AT_FORMAT))}
                {" · "}
                <a href={c.savedClip.memoUrl} target="_blank" rel="noreferrer" className="underline">
                  {t("popupOpenMemo")}
                </a>
              </p>
            ) : null}
            {error ? <ErrorBar error={error} busy={c.busy} onRetry={onSave} /> : null}
            {failedImages ? (
              <p role="status" className="text-xs text-destructive">
                {tp("popupFailedImages", failedImages)}
              </p>
            ) : null}
          </>
        ) : null}
      </main>
      {draft ? (
        <footer className="flex shrink-0 items-center gap-2 border-t bg-background p-3">
          <Select
            items={visibilityItems}
            value={draft.visibility}
            onValueChange={(value) => edit({ visibility: value as Visibility })}
            disabled={editingDisabled}
          >
            <SelectTrigger aria-label={t("popupVisibility")} className="w-28">
              <VisibilityIcon />
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top" align="start">
              {(Object.keys(visibilityItems) as Visibility[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {visibilityItems[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            className="min-w-0 flex-1"
            onClick={onSave}
            disabled={disabled || saved || !draft.confirmed || !c.capabilities?.supported || c.overLimit || !c.content.trim()}
          >
            {saved ? <CheckCircle2Icon /> : null}
            {c.busy ? t("commonSaving") : saved ? t("popupSavedToMemos") : c.savedClip ? t("popupSaveAgain") : t("popupSaveToMemos")}
          </Button>
        </footer>
      ) : null}
    </Frame>
  );
}

export function App() {
  const state = usePopupState();
  const lastReady = useRef<ReadyPopupState | null>(null);
  if (state?.status === "ready") lastReady.current = state;
  const template = state && state.status !== "signed-out" ? state.template : null;
  const expectation =
    state?.status === "ready" ? { source: state.source, connectionId: state.identity.userId, instanceUrl: state.instanceUrl } : null;
  const clipper = useClipper(expectation, template);
  if (!state)
    return (
      <Frame>
        <Header left={<AppBrand />} />
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      </Frame>
    );
  if (state.status !== "ready" && lastReady.current) return <SignedInView c={clipper} state={lastReady.current} blocked={state} />;
  if (state.status === "signed-out")
    return (
      <Frame>
        <Header left={<AppBrand />} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-muted-foreground">{t("popupChooseConnection")}</p>
          <Button onClick={openOptions}>{t("commonOpenSettings")}</Button>
        </div>
      </Frame>
    );
  if (state.status === "disconnected") return <GatePrompt body={t("popupConnectToStart")} identity={state.identity} />;
  if (state.status === "unsupported") {
    const detail = describeSaveError("unsupported-version");
    return (
      <GatePrompt
        title={detail.title}
        body={detail.why}
        learnMore={detail.learnMore}
        instanceUrl={state.instanceUrl}
        identity={state.identity}
      />
    );
  }
  return <SignedInView c={clipper} state={state} />;
}
