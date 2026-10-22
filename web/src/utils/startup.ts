/** Hands the static startup screen over to a committed application or error page. */
export const finishStartup = () => {
  window.dispatchEvent(new Event("memos:startup-ready"));
};
