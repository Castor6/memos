import browser from "webextension-polyfill";
import type { BackgroundRequest } from "./background-protocol";
import type { ClipSaveStatus } from "./clip-records";
import type {
  AttachmentPreviewResult,
  AuthUserResult,
  CaptureCapabilitiesResult,
  ClipRecordsResult,
  ConnectionActionResult,
  ConnectionStateResult,
  MemoTagsResult,
  PopupStateResult,
  SaveResult,
} from "./messages";

type BackgroundResponses = {
  GET_ATTACHMENT_PREVIEW: AttachmentPreviewResult;
  GET_POPUP_STATE: PopupStateResult;
  GET_AUTH_USER: AuthUserResult;
  GET_CONNECTION_STATE: ConnectionStateResult;
  GET_CLIP_STATUS: ClipSaveStatus | null;
  LIST_CLIP_RECORDS: ClipRecordsResult;
  GET_CAPTURE_CAPABILITIES: CaptureCapabilitiesResult;
  GET_MEMO_TAGS: MemoTagsResult;
  CONNECT_DIRECT: ConnectionActionResult;
  ACTIVATE_USEMEMOS_CONNECTION: ConnectionActionResult;
  SAVE_MEMO: SaveResult;
};

type BackgroundResponse<T extends BackgroundRequest> = T["type"] extends keyof BackgroundResponses
  ? BackgroundResponses[T["type"]]
  : undefined;

/** Typed one-shot client for the popup/options → service-worker protocol. */
export async function sendBackgroundRequest<T extends BackgroundRequest>(request: T): Promise<BackgroundResponse<T>> {
  return (await browser.runtime.sendMessage(request)) as BackgroundResponse<T>;
}
