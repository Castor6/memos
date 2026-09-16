const SPACE_KEY = "memos-active-space";

/** Selection is local to this tab; space definitions and preferences live on the server. */
export function getActiveSpace(): string {
  return sessionStorage.getItem(SPACE_KEY) || "";
}

export function switchSpace(space: string): void {
  sessionStorage.setItem(SPACE_KEY, space);
  // A fresh navigation discards all queries and in-flight responses from the old space.
  window.location.assign("/");
}
