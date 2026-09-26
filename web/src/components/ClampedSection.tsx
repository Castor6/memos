import { ChevronDown, ChevronUp } from "lucide-react";
import { createContext, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useTranslate } from "@/utils/i18n";

// A collapsed section shows this much content; anything taller folds behind a fade.
export const CLAMP_PREVIEW_HEIGHT_PX = 360;
// Only fold when content is taller than this, so cards barely over the preview aren't
// clamped for the sake of a few hidden pixels.
export const CLAMP_TRIGGER_HEIGHT_PX = 420;

export const ExpandClampedSectionContext = createContext<(() => void) | undefined>(undefined);

interface ClampedSectionProps {
  /** When false, children render untouched with no measurement. */
  enabled: boolean;
  characterLimit?: number;
  textLength?: number;
  children: ReactNode | ((collapsed: boolean) => ReactNode);
}

/**
 * The one truncation mechanism for compact cards: measure the content, and when it is
 * tall enough, collapse it to a fixed-height preview with a fade and a Show more/less
 * toggle. The inner div is never clamped, so observing it keeps the measurement live
 * while images and embeds load.
 */
const ClampedSection = ({ enabled, children, characterLimit = 0, textLength = 0 }: ClampedSectionProps) => {
  const t = useTranslate();
  const measureRef = useRef<HTMLDivElement>(null);
  const textTooLong = characterLimit > 0 && textLength > characterLimit;
  const [clamped, setClamped] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = measureRef.current;
    if (!enabled || !el) {
      setClamped(false);
      return;
    }
    const check = () => setClamped(textTooLong || el.offsetHeight > CLAMP_TRIGGER_HEIGHT_PX);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, textTooLong]);

  const expandForDetails = useCallback(() => {
    if (enabled) setExpanded(true);
  }, [enabled]);

  const collapsed = enabled && (clamped || textTooLong) && !expanded;

  return (
    <ExpandClampedSectionContext.Provider value={expandForDetails}>
      <div
        className={cn("relative w-full", collapsed && "overflow-hidden")}
        style={collapsed ? { maxHeight: CLAMP_PREVIEW_HEIGHT_PX } : undefined}
      >
        <div ref={measureRef} className="w-full flex flex-col justify-start items-start gap-2">
          {typeof children === "function" ? children(collapsed) : children}
        </div>
        {collapsed && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-card from-0% via-card/60 via-40% to-transparent to-100%" />
        )}
      </div>
      {enabled && (clamped || textTooLong) && (
        <button
          type="button"
          className="inline-flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setExpanded((prev) => !prev)}
        >
          <span>{t(collapsed ? "memo.show-more" : "memo.show-less")}</span>
          {collapsed ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
        </button>
      )}
    </ExpandClampedSectionContext.Provider>
  );
};

export default ClampedSection;
