import type { ReactNode } from "react";
import MemoPrivacyGuard from "@/components/MemoPrivacyGuard";
import type { PrivateMemoIdentity } from "@/contexts/PrivateMemoVisibilityContext";
import { cn } from "@/lib/utils";

export default function RelationPrivacyGuard({
  memo,
  enabled = true,
  children,
  className,
}: {
  memo?: PrivateMemoIdentity;
  enabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  if (!enabled) return children;
  // Unknown identities remain concealed, including after a failed lookup.
  if (!memo)
    return (
      <div inert aria-hidden="true" className={cn("min-w-0 select-none blur-lg", className)} data-relation-unresolved>
        {children}
      </div>
    );
  return (
    <MemoPrivacyGuard memo={memo} className={className}>
      {children}
    </MemoPrivacyGuard>
  );
}
