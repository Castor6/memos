/** Reveal a folded heading only when it falls outside a scrolling viewport. */
export function revealFoldHeading(heading: HTMLElement) {
  const rect = heading.getBoundingClientRect();
  let top = 0;
  let bottom = window.innerHeight;
  for (let parent = heading.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll|hidden)/.test(getComputedStyle(parent).overflowY)) {
      const bounds = parent.getBoundingClientRect();
      top = Math.max(top, bounds.top);
      bottom = Math.min(bottom, bounds.bottom);
    }
  }
  if (rect.top < top || rect.bottom > bottom) heading.scrollIntoView({ block: "nearest" });
}
