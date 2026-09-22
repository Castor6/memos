import type { ConnectionSource } from "./connection-config";
import { t } from "./i18n";
import { MIN_SUPPORTED_VERSION_LABEL } from "./versions";

/** Failure modes of an actual HTTP request to the user's Memos instance. */
export type InstanceErrorKind =
  | "mixed-content"
  | "cors"
  | "unreachable"
  | "unauthorized"
  | "timeout"
  | "bad-response"
  | "capture-unsupported"
  | "content-too-large"
  | "invalid-content"
  | "not-found"
  | "unsupported-version";

/** Client-side preconditions that fail before any request is made. */
export type ClientErrorKind = "not-configured" | "auth-changed" | "auth-unavailable" | "extension-error" | "invalid-url" | "storage-error";

/** Everything a save attempt can report back to the UI. */
export type SaveErrorKind = InstanceErrorKind | ClientErrorKind;

export type SaveErrorDetail = {
  kind: SaveErrorKind;
  title: string;
  why: string;
  howToFix: string[];
  /**
   * Where the fix lives, so the UI can offer a button instead of prose:
   * "settings" → the connection/config is broken (reconnect in options); "retry" → transient, try again.
   */
  primaryAction: "settings" | "retry";
  /** Optional external guide (e.g. the upgrade docs) surfaced as a link by the UI. */
  learnMore?: { label: string; url: string };
};

/** The Memos self-host upgrade guide, linked when the instance is too old. */
export const MEMOS_UPGRADE_DOCS_URL = "https://www.usememos.com/docs/operations/upgrade";

export class InstanceError extends Error {
  readonly kind: InstanceErrorKind;
  constructor(kind: InstanceErrorKind, message?: string) {
    super(message ?? kind);
    this.name = "InstanceError";
    this.kind = kind;
  }
}

export class ClientError extends Error {
  readonly kind: ClientErrorKind;
  constructor(kind: ClientErrorKind) {
    super(kind);
    this.name = "ClientError";
    this.kind = kind;
  }
}

/** Maps a thrown error to the SaveErrorKind the UI can describe. */
export function toSaveErrorKind(error: unknown): SaveErrorKind {
  return error instanceof InstanceError || error instanceof ClientError ? error.kind : "bad-response";
}

export function describeSaveError(kind: SaveErrorKind, source?: ConnectionSource | null): SaveErrorDetail {
  switch (kind) {
    case "capture-unsupported":
      return {
        kind,
        primaryAction: "settings",
        title: "服务器尚不支持同步",
        why: "当前 Memos 未提供 Star / Pick up 同步能力。",
        howToFix: ["升级到支持剪藏同步的定制版本后重试。"],
      };
    case "content-too-large":
      return {
        kind,
        primaryAction: "retry",
        title: "正文超过服务器上限",
        why: "按 UTF-8 计算的正文大小超过服务器允许的范围。",
        howToFix: ["保留草稿，缩短原文或提高 Memos 正文大小限制后重试。"],
      };
    case "invalid-content":
      return {
        kind,
        primaryAction: "retry",
        title: "服务器未接受此记录",
        why: "记录内容或剪藏信息未通过服务器校验。",
        howToFix: ["检查正文和来源信息后重试，草稿会保留。"],
      };
    case "not-found":
      return {
        kind,
        primaryAction: "retry",
        title: "记录已不存在",
        why: "服务器找不到这条记录，可能已经删除。",
        howToFix: ["刷新历史查看当前记录。"],
      };
    case "invalid-url":
      return {
        kind,
        primaryAction: "settings",
        title: t("errorInvalidUrlTitle"),
        why: t("errorInvalidUrlWhy"),
        howToFix: [t("errorInvalidUrlFix")],
      };
    case "extension-error":
      return {
        kind,
        primaryAction: "retry",
        title: t("errorExtensionTitle"),
        why: t("errorExtensionWhy"),
        howToFix: [t("errorExtensionFix")],
      };
    case "storage-error":
      return {
        kind,
        primaryAction: "retry",
        title: t("errorStorageTitle"),
        why: t("errorStorageWhy"),
        howToFix: [t("errorStorageFix")],
      };
    case "auth-changed":
      return {
        kind,
        primaryAction: "retry",
        title: t("errorAuthChangedTitle"),
        why: t("errorAuthChangedWhy"),
        howToFix: [t("errorAuthChangedFix")],
      };
    case "auth-unavailable":
      return {
        kind,
        primaryAction: "retry",
        title: t("errorAuthUnavailableTitle"),
        why: t("errorAuthUnavailableWhy"),
        howToFix: [t("errorAuthUnavailableFix")],
      };
    case "not-configured":
      return {
        kind,
        primaryAction: "settings",
        title: t("errorNotConfiguredTitle"),
        why: t("errorNotConfiguredWhy"),
        howToFix: [t("errorNotConfiguredFix")],
      };
    case "mixed-content":
      return {
        kind,
        primaryAction: "settings",
        title: t("errorMixedContentTitle"),
        why: t("errorMixedContentWhy"),
        howToFix: [t("errorMixedContentFixHttps"), t("errorMixedContentFixLocal")],
      };
    case "cors":
      return {
        kind,
        primaryAction: "settings",
        title: t("errorCorsTitle"),
        why: t("errorCorsWhy"),
        howToFix: [t("errorCorsFixOnline"), t("errorCorsFixUrl")],
      };
    case "unreachable":
      return {
        kind,
        primaryAction: "retry",
        title: t("errorUnreachableTitle"),
        why: t("errorUnreachableWhy"),
        howToFix: [t("errorUnreachableFixOnline"), t("errorUnreachableFixOpen")],
      };
    case "unauthorized":
      return {
        kind,
        primaryAction: "settings",
        title: t("errorUnauthorizedTitle"),
        why: t("errorUnauthorizedWhy"),
        howToFix:
          source === "direct"
            ? [t("errorUnauthorizedDirectFixReplace"), t("errorUnauthorizedDirectFixCreate")]
            : [t("errorUnauthorizedAccountFixReconnect"), t("errorUnauthorizedAccountFixRegenerate")],
      };
    case "timeout":
      return {
        kind,
        primaryAction: "retry",
        title: t("errorTimeoutTitle"),
        why: t("errorTimeoutWhy"),
        howToFix: [t("errorTimeoutFixOnline"), t("errorTimeoutFixRetry")],
      };
    case "unsupported-version":
      return {
        kind,
        primaryAction: "settings",
        title: t("errorUnsupportedTitle"),
        why: t("errorUnsupportedWhy", MIN_SUPPORTED_VERSION_LABEL),
        howToFix: [t("errorUnsupportedFix", MIN_SUPPORTED_VERSION_LABEL)],
        learnMore: { label: t("errorUpgradeGuide"), url: MEMOS_UPGRADE_DOCS_URL },
      };
    case "bad-response":
      return {
        kind: "bad-response",
        primaryAction: "settings",
        title: t("errorBadResponseTitle"),
        why: t("errorBadResponseWhy"),
        howToFix: [t("errorBadResponseFixApi"), t("errorBadResponseFixRedirect")],
      };
    default: {
      // Exhaustiveness guard: if a new InstanceErrorKind is added without a case, this fails to compile.
      const _exhaustive: never = kind;
      void _exhaustive;
      return describeSaveError("bad-response");
    }
  }
}
