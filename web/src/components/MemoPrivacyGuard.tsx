import type { ReactNode } from "react";
import { type PrivateMemoIdentity, useMemoPrivacy } from "@/contexts/PrivateMemoVisibilityContext";
import { useTranslate } from "@/utils/i18n";
import MemoContentMask from "./MemoContentMask";

export default function MemoPrivacyGuard({
  memo,
  children,
  className,
}: {
  memo: PrivateMemoIdentity;
  children: ReactNode;
  className?: string;
}) {
  const { hidden, reveal } = useMemoPrivacy(memo);
  const t = useTranslate();
  return (
    <MemoContentMask hidden={hidden} onReveal={reveal} label={t("memo.mcp-privacy.show-content")} className={className}>
      {children}
    </MemoContentMask>
  );
}
