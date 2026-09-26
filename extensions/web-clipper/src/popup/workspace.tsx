import { CheckCircle2Icon, EarthIcon, LockIcon, TriangleAlertIcon, UsersRoundIcon } from "lucide-react";
import { useState } from "react";
import browser from "webextension-polyfill";
import { MarkdownPreview } from "@/components/markdown-preview";
import { TagEditor } from "@/components/tag-editor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { describeSaveError, type SaveErrorDetail } from "@/lib/errors";
import { formatDateTime, t, tp } from "@/lib/i18n";
import type { Visibility } from "@/lib/memos-client";
import type { PopupState } from "@/lib/popup-state";
import { GrowingTextarea } from "./growing-textarea";
import type { useClipper } from "./use-clipper";

type ClipperState = ReturnType<typeof useClipper>;
type ReadyState = Extract<PopupState, { status: "ready" }>;
type View = "thought" | "source" | "preview";
const views: Array<{ id: View; label: string }> = [
  { id: "thought", label: "我的产出" },
  { id: "source", label: "原内容" },
  { id: "preview", label: "保存预览" },
];

/** A single document scrolls while source and final preview each get the full reading width. */
export function ClipWorkspace({ c, state, blocked }: { c: ClipperState; state: ReadyState; blocked?: boolean }) {
  const [view, setView] = useState<View>("thought");
  const [editingSource, setEditingSource] = useState(false);
  const [error, setError] = useState<SaveErrorDetail | null>(null);
  const [saved, setSaved] = useState(false);
  const [failedImages, setFailedImages] = useState(0);
  const [failedImageDetails, setFailedImageDetails] = useState<Array<{ url: string; reason: string }>>([]);
  const draft = c.draft;
  const isPickup = draft?.capture.kind === "PICK_UP";
  const disabled = c.busy || c.extracting || !!blocked;
  const editingDisabled = disabled || c.awaitingConfirmation;
  const previewConnection = {
    expectedSource: state.source,
    expectedConnectionId: state.identity.userId,
    expectedInstanceUrl: state.instanceUrl,
  };
  const clearFeedback = () => {
    setSaved(false);
    setError(null);
    setFailedImages(0);
    setFailedImageDetails([]);
  };
  const edit = (change: Parameters<ClipperState["update"]>[0], fields?: Parameters<ClipperState["update"]>[1]) => {
    clearFeedback();
    c.update(change, fields);
  };
  const onSave = async () => {
    clearFeedback();
    const result = await c.save();
    if (result.ok) {
      setSaved(true);
      setFailedImages(result.failedImages ?? 0);
      setFailedImageDetails(result.failedImageDetails ?? []);
    } else setError(describeSaveError(result.errorKind, state.source));
  };
  const visibilityItems = { PRIVATE: t("commonPrivate"), PROTECTED: t("commonProtected"), PUBLIC: t("commonPublic") };
  const visibilityIcons = { PRIVATE: LockIcon, PROTECTED: UsersRoundIcon, PUBLIC: EarthIcon };
  const VisibilityIcon = visibilityIcons[draft?.visibility ?? "PRIVATE"];
  const cannotSave = disabled || !draft?.confirmed || !c.capabilities?.supported || c.overLimit || !c.content.trim();
  const saveReason = blocked
    ? "连接不可用，草稿已保留。"
    : !draft?.confirmed
      ? "请在我的产出中确认评论由你发表。"
      : c.overLimit
        ? "正文已超限，请精简原内容或调整实例正文上限。"
        : !c.capabilities?.supported
          ? "正在确认服务器是否支持保存。"
          : "";

  return (
    <>
      <main className="clipper-workspace">
        <div className="clipper-mode-row">
          <fieldset className="clipper-modes" aria-label="保存方式">
            {(["STAR", "PICK_UP"] as const).map((kind) => (
              <Button
                key={kind}
                variant="ghost"
                aria-pressed={draft?.capture.kind === kind}
                disabled={!c.ready || disabled || !c.tab?.url}
                onClick={() => {
                  clearFeedback();
                  setView("thought");
                  setEditingSource(false);
                  void c.start(kind);
                }}
              >
                {kind === "STAR" ? "Star" : "Pick up"}
              </Button>
            ))}
          </fieldset>
          <span className="text-sm text-muted-foreground">个人空间</span>
        </div>
        {!draft && !c.extracting ? (
          <section className="clipper-empty">
            <h1>留下你的思考</h1>
            <p>Star 剪藏当前网页；Pick up 留存你在 X 的发帖、回复或引用帖。</p>
            <p className="text-sm text-muted-foreground">
              {c.tab?.url ? "选择后才提取正文，本地草稿会自动恢复。" : "请回到要剪藏的网页，点击浏览器工具栏中的扩展图标。"}
            </p>
          </section>
        ) : null}
        {c.extracting ? (
          <p role="status" className="flex items-center gap-2 py-4">
            <Spinner />
            正在提取原网页…
          </p>
        ) : null}
        {blocked ? (
          <Alert>
            <AlertTitle>连接不可用</AlertTitle>
            <AlertDescription>{t("popupDraftPreserved")}</AlertDescription>
            <Button size="sm" variant="outline" onClick={() => void browser.runtime.openOptionsPage()}>
              {t("commonOpenSettings")}
            </Button>
          </Alert>
        ) : null}
        {c.capabilityError || (c.capabilities && !c.capabilities.supported) ? (
          <Alert variant="destructive">
            <AlertTitle>暂时无法保存</AlertTitle>
            <AlertDescription>
              {c.capabilityError || "当前服务器尚不支持 Star / Pick up 记录同步，请升级 Memos。草稿会保留。"}
            </AlertDescription>
            <Button size="sm" variant="outline" onClick={c.retryCapabilities}>
              重试连接
            </Button>
          </Alert>
        ) : null}
        {draft ? (
          <>
            <div className="clipper-views" role="tablist" aria-label="编辑与核对">
              {views.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  id={`view-${item.id}`}
                  aria-controls={`panel-${item.id}`}
                  aria-selected={view === item.id}
                  tabIndex={view === item.id ? 0 : -1}
                  onClick={() => setView(item.id)}
                  onKeyDown={(event) => {
                    const next =
                      event.key === "ArrowRight"
                        ? (index + 1) % views.length
                        : event.key === "ArrowLeft"
                          ? (index + views.length - 1) % views.length
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? views.length - 1
                              : null;
                    if (next === null) return;
                    event.preventDefault();
                    setView(views[next]!.id);
                    document.getElementById(`view-${views[next]!.id}`)?.focus();
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {view === "thought" ? (
              <section role="tabpanel" id="panel-thought" aria-labelledby="view-thought">
                <div className="clipper-tags">
                  <span className="text-sm text-muted-foreground">标签</span>
                  <TagEditor
                    tags={draft.tags}
                    suggestions={c.tagSuggestions}
                    onChange={(tags) => edit({ tags })}
                    disabled={editingDisabled}
                    loading={c.tagsLoading}
                    error={c.tagsError}
                    onRetry={c.retryTags}
                  />
                </div>
                {isPickup ? (
                  <>
                    <div className="clipper-field-heading">
                      <h1>Pick up</h1>
                      <span>已发表的原话 · 只读</span>
                    </div>
                    <div className="clipper-published">
                      <MarkdownPreview content={draft.capture.comment} connection={previewConnection} expanded />
                    </div>
                    {!draft.confirmed ? (
                      <label className="mb-6 flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.confirmed}
                          disabled={editingDisabled}
                          onChange={(event) => edit({ confirmed: event.target.checked })}
                        />
                        页面未能确认登录身份，我确认上方内容由我发表。
                      </label>
                    ) : null}
                    <div className="clipper-field-heading">
                      <label htmlFor="capture-context">Context & thinking</label>
                      <span>可选</span>
                    </div>
                    <GrowingTextarea
                      id="capture-context"
                      aria-label="Context & thinking"
                      value={draft.capture.context}
                      disabled={editingDisabled}
                      placeholder="哪些背景、线索和思考促成了这条发帖？"
                      onValueChange={(context) => edit({}, { context })}
                    />
                  </>
                ) : (
                  <>
                    <div className="clipper-field-heading">
                      <label htmlFor="capture-comment">我的思考</label>
                      <span>可选</span>
                    </div>
                    <GrowingTextarea
                      id="capture-comment"
                      aria-label="我的思考"
                      value={draft.capture.comment}
                      disabled={editingDisabled}
                      placeholder="什么吸引了你？你认同、质疑或联想到了什么？"
                      onValueChange={(comment) => edit({}, { comment })}
                    />
                  </>
                )}
                <p className="mt-2 text-sm text-muted-foreground">Enter / Shift + Enter / Ctrl + Enter 换行</p>
                <div className="clipper-source-reference">
                  <span>来源</span>
                  <a href={draft.capture.sourceUrl} target="_blank" rel="noreferrer">
                    {draft.title || draft.capture.sourceUrl}
                  </a>
                </div>
              </section>
            ) : view === "source" ? (
              <section role="tabpanel" id="panel-source" aria-labelledby="view-source">
                <div className="clipper-field-heading">
                  <h1>{isPickup ? "What they put down" : "原内容"}</h1>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" disabled={editingDisabled} onClick={() => setEditingSource(!editingSource)}>
                      {editingSource ? "完成编辑" : "编辑原内容"}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={editingDisabled}
                      onClick={() => {
                        clearFeedback();
                        void c.start(draft.capture.kind, true);
                      }}
                    >
                      重新提取原内容
                    </Button>
                  </div>
                </div>
                {editingSource ? (
                  <GrowingTextarea
                    aria-label="原内容"
                    value={draft.original}
                    disabled={editingDisabled}
                    onValueChange={(original) => edit({ original })}
                  />
                ) : isPickup && !draft.original.trim() ? (
                  <p className="text-sm text-muted-foreground">已按独立发帖整理，保存时不包含上文章节。</p>
                ) : (
                  <MarkdownPreview content={draft.original} connection={previewConnection} expanded />
                )}
                <p className="mt-4 text-sm text-muted-foreground">可编辑保存的正文；Pick up 的原始互动快照另行保留。</p>
              </section>
            ) : (
              <section role="tabpanel" id="panel-preview" aria-labelledby="view-preview">
                <div className="clipper-field-heading">
                  <h1>保存预览</h1>
                  <span>按笔记顺序显示</span>
                </div>
                <MarkdownPreview content={c.content} connection={previewConnection} expanded />
              </section>
            )}
            {draft.warnings.length ? (
              <ul className="mt-6 list-inside list-disc space-y-1 text-sm text-amber-700 dark:text-amber-400">
                {draft.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            <div className="clipper-feedback">
              {c.notice ? <p role="status">{c.notice}</p> : null}
              {c.storageError ? (
                <p role="alert" className="text-destructive">
                  {c.storageError}
                </p>
              ) : null}
              {c.statusError ? <p role="status">{c.statusError}</p> : null}
              {draft.images.length ? <p>{draft.images.length} 张图片将尝试保存为附件。</p> : null}
              <p role={c.overLimit ? "alert" : "status"} className={c.overLimit ? "text-destructive" : ""}>
                预计正文 {c.contentBytes.toLocaleString()} 字节
                {c.capabilities ? ` / 上限 ${c.capabilities.contentMaxBytes.toLocaleString()} 字节` : " · 正在读取服务器限制…"}
              </p>
              {c.savedClip ? (
                <p role="status">
                  {t(
                    "popupSavedAt",
                    formatDateTime(c.savedClip.savedAt, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
                  )}
                  {" · "}
                  <a className="underline" href={c.savedClip.memoUrl} target="_blank" rel="noreferrer">
                    {t("popupOpenMemo")}
                  </a>
                </p>
              ) : null}
              {error ? (
                <Alert variant="destructive">
                  <TriangleAlertIcon />
                  <AlertTitle>{error.title}</AlertTitle>
                  <AlertDescription>
                    {error.why} {error.howToFix[0]}
                    {error.learnMore ? (
                      <a href={error.learnMore.url} target="_blank" rel="noreferrer">
                        {error.learnMore.label}
                      </a>
                    ) : null}
                  </AlertDescription>
                  <div className="col-start-2 flex gap-2">
                    {error.primaryAction === "settings" ? (
                      <Button size="sm" onClick={() => void browser.runtime.openOptionsPage()}>
                        {t("commonOpenSettings")}
                      </Button>
                    ) : null}
                    <Button size="sm" disabled={c.busy || cannotSave} onClick={() => void onSave()}>
                      {c.busy ? t("commonRetrying") : t("commonTryAgain")}
                    </Button>
                  </div>
                </Alert>
              ) : null}
              {failedImages ? (
                <p role="status" className="text-destructive">
                  {tp("popupFailedImages", failedImages)}
                </p>
              ) : null}
              {failedImageDetails.length ? (
                <section aria-label="未转存的图片" className="space-y-2 text-destructive">
                  <h2>未转存的图片（已保留原链接）</h2>
                  <ul className="space-y-2">
                    {failedImageDetails.map(({ url, reason }) => (
                      <li key={url}>
                        <p className="break-all" title={url}>
                          {url.length > 180 ? `${url.slice(0, 140)}…${url.slice(-24)}` : url}
                        </p>
                        <p>{reason}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          </>
        ) : c.notice ? (
          <p role="status">{c.notice}</p>
        ) : null}
      </main>
      {draft ? (
        <footer className="clipper-save-bar">
          <div className="clipper-save-inner">
            <p role="status" className="min-w-0 text-sm text-muted-foreground">
              {c.busy
                ? "正在转存图片并保存笔记…"
                : saveReason || (saved ? "已保存到 Memos" : c.awaitingConfirmation ? "上次保存结果待确认" : "本地草稿自动保留")}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Select
                items={visibilityItems}
                value={draft.visibility}
                onValueChange={(value) => edit({ visibility: value as Visibility })}
                disabled={editingDisabled}
              >
                <SelectTrigger aria-label={t("popupVisibility")} className="w-32">
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
              <Button className="min-w-36" disabled={cannotSave} onClick={() => void onSave()}>
                {saved ? <CheckCircle2Icon /> : null}
                {c.busy
                  ? t("commonSaving")
                  : c.awaitingConfirmation
                    ? "确认上次保存结果"
                    : saved
                      ? "另存一条"
                      : c.savedClip
                        ? "另存一条"
                        : t("popupSaveToMemos")}
              </Button>
            </div>
          </div>
        </footer>
      ) : null}
    </>
  );
}
