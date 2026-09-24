import { Tooltip } from "@base-ui/react/tooltip";
import { ExternalLinkIcon, GlobeIcon, HistoryIcon, SettingsIcon } from "lucide-react";
import { useRef } from "react";
import browser from "webextension-polyfill";
import { AccountBadge } from "@/components/account-badge";
import { AppBrand } from "@/components/app-brand";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { EditorSource } from "@/lib/editor-page";
import { describeSaveError } from "@/lib/errors";
import { t } from "@/lib/i18n";
import type { PopupIdentity, PopupState } from "@/lib/popup-state";
import { useClipper } from "./use-clipper";
import { usePopupState } from "./use-popup-state";
import { ClipWorkspace } from "./workspace";

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
 * Slim toolbar shared by every editor view: identity on the left, quick links on the right —
 * the user's instance (when connected) and the options page.
 */
function Header({ left, instanceUrl }: { left: React.ReactNode; instanceUrl?: string | null }) {
  return (
    <header className="clipper-header">
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

// The document owns scrolling; editing fields grow within the full-page workspace.
function Frame({ children }: { children: React.ReactNode }) {
  return <div className="clipper-editor">{children}</div>;
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
      <div className="clipper-gate">
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

function SignedInView({
  c,
  state,
  blocked,
}: {
  c: ReturnType<typeof useClipper>;
  state: Extract<PopupState, { status: "ready" }>;
  blocked?: Exclude<PopupState, { status: "ready" }>;
}) {
  return (
    <Frame>
      <Header
        left={
          <div className="flex min-w-0 flex-wrap items-center gap-4">
            <AppBrand sub="剪藏工作区" />
            <IdentityBadge identity={state.identity} />
          </div>
        }
        instanceUrl={state.instanceUrl}
      />
      <ClipWorkspace key={`${state.source}:${state.identity.userId}:${state.instanceUrl}`} c={c} state={state} blocked={!!blocked} />
    </Frame>
  );
}

export function App({ source }: { source?: EditorSource | null }) {
  const state = usePopupState();
  const lastReady = useRef<Extract<PopupState, { status: "ready" }> | null>(null);
  if (state?.status === "ready") lastReady.current = state;
  const template = state && state.status !== "signed-out" ? state.template : null;
  const expectation =
    state?.status === "ready" ? { source: state.source, connectionId: state.identity.userId, instanceUrl: state.instanceUrl } : null;
  const clipper = useClipper(expectation, template, source);
  if (!state)
    return (
      <Frame>
        <Header left={<AppBrand />} />
        <div className="clipper-gate">
          <Spinner />
        </div>
      </Frame>
    );
  if (state.status !== "ready" && lastReady.current) return <SignedInView c={clipper} state={lastReady.current} blocked={state} />;
  if (state.status === "signed-out")
    return (
      <Frame>
        <Header left={<AppBrand />} />
        <div className="clipper-gate">
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
