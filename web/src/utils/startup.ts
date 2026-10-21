/** Hands the static startup screen over to a committed application or error page. */
export const finishStartup = (success = true) => {
  window.dispatchEvent(new CustomEvent("memos:startup-ready", { detail: { success } }));
};

/** Reveals a returning visitor's verified route shell without marking the page loaded. */
export const revealStartupShell = () => {
  window.dispatchEvent(new Event("memos:startup-shell-ready"));
};
