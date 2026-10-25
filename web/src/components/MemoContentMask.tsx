import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  hidden: boolean;
  onReveal: () => void;
  label: string;
  children: ReactNode;
  className?: string;
  showLabel?: boolean;
}

export default function MemoContentMask({ hidden, onReveal, label, children, className, showLabel = false }: Props) {
  return (
    <div className={cn("relative min-w-0", className)} data-content-hidden={hidden || undefined}>
      <div inert={hidden || undefined} aria-hidden={hidden || undefined} className={cn(hidden && "select-none blur-lg")}>
        {children}
      </div>
      {hidden && (
        <button
          type="button"
          aria-label={label}
          className="absolute inset-0 flex size-full cursor-pointer items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-primary"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onReveal();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {showLabel && <span className="rounded-lg border border-border bg-card px-2 py-1 text-xs text-muted-foreground">{label}</span>}
        </button>
      )}
    </div>
  );
}
