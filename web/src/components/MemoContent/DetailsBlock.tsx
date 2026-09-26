import { Children, type ComponentProps, isValidElement, useContext, useRef } from "react";
import type { ExtraProps } from "react-markdown";
import { ExpandClampedSectionContext } from "@/components/ClampedSection";
import { revealFoldHeading } from "@/components/Details/scroll";
import { cn } from "@/lib/utils";
import { useTranslate } from "@/utils/i18n";
import "@/components/Details/details.css";

export function DetailsBlock({ node: _node, children, className, ...props }: ComponentProps<"details"> & ExtraProps) {
  const ref = useRef<HTMLDetailsElement>(null);
  const expandCard = useContext(ExpandClampedSectionContext);
  const t = useTranslate();
  const nodes = Children.toArray(children);
  const summary = nodes.find((child) => isValidElement(child) && child.type === "summary");
  return (
    <details
      {...props}
      ref={ref}
      className={cn("memo-details", className)}
      onToggle={(event) => {
        if (event.currentTarget.open) expandCard?.();
      }}
    >
      {summary || <summary>{t("memo.show-more")}</summary>}
      <div className="memo-details-body">{nodes.filter((child) => child !== summary)}</div>
      <div className="memo-details-footer">
        <button
          type="button"
          className="memo-details-close"
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            const details = ref.current;
            if (!details) return;
            details.open = false;
            const heading = details.querySelector("summary");
            if (heading) {
              heading.focus({ preventScroll: true });
              revealFoldHeading(heading);
            }
          }}
        >
          {t("memo.show-less")}
        </button>
      </div>
    </details>
  );
}
