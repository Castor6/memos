import { type KeyboardEvent, type MouseEvent, useCallback, useRef, useState } from "react";

export interface MemoContextMenuPosition {
  x: number;
  y: number;
}

const nativeMenuTarget = (target: EventTarget | null) =>
  target instanceof Element &&
  Boolean(target.closest("a, img, picture, video, audio, input, textarea, select, button, [contenteditable], [role=checkbox]"));

/** Open card actions at the pointer while preserving native selection/media menus. */
export function useMemoContextMenu() {
  const [position, setPosition] = useState<MemoContextMenuPosition | null>(null);
  const pointerType = useRef("");
  const close = useCallback(() => setPosition(null), []);
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (pointerType.current === "touch" || nativeMenuTarget(event.target) || window.getSelection()?.toString()) return;
    event.preventDefault();
    event.stopPropagation();
    setPosition({ x: event.clientX, y: event.clientY });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setPosition({ x: rect.left + 16, y: rect.top + 16 });
  };
  return {
    position,
    close,
    handlers: {
      onContextMenu,
      onKeyDown,
      onPointerDown: (event: React.PointerEvent) => {
        pointerType.current = event.pointerType;
      },
    },
  };
}
