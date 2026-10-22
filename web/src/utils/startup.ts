/** Hands the static startup screen over to a committed application or error page. */
export const finishStartup = (success = true) => {
  window.dispatchEvent(new CustomEvent("memos:startup-ready", { detail: { success } }));
};
