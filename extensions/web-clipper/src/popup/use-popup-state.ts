import { useEffect, useState } from "react";
import browser from "webextension-polyfill";
import { type PopupState, readPopupState, writePopupState } from "@/lib/popup-state";
import { sendBackgroundRequest } from "@/lib/runtime-client";

/**
 * Returns the durable UI snapshot first, then replaces it with the background OAuth session's
 * authoritative state. Both reads begin immediately; network latency never blocks the cached render.
 */
export function usePopupState(): PopupState | null {
  const [state, setState] = useState<PopupState | null>(null);

  useEffect(() => {
    let active = true;
    let revision = 0;
    const livePromise = sendBackgroundRequest({ type: "GET_POPUP_STATE" }).catch(() => undefined);

    const initialRevision = revision;
    void (async () => {
      const cached = await readPopupState();
      if (active && cached && revision === initialRevision) setState(cached);

      const live = await livePromise;
      if (!active || !live || revision !== initialRevision) return;
      setState(live);
      await writePopupState(live);
    })();

    const onAuthChanged = (message: unknown) => {
      if (!message || typeof message !== "object" || !("type" in message) || message.type !== "AUTH_CHANGED") return;
      const request = ++revision;
      void sendBackgroundRequest({ type: "GET_POPUP_STATE" })
        .then((live) => {
          if (active && live && request === revision) setState(live);
        })
        .catch(() => {});
    };
    browser.runtime.onMessage.addListener(onAuthChanged);

    return () => {
      active = false;
      browser.runtime.onMessage.removeListener(onAuthChanged);
    };
  }, []);

  return state;
}
