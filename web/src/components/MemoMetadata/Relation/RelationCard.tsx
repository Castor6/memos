import { useLocation } from "react-router-dom";
import MemoSnippetLink from "@/components/MemoView/components/MemoSnippetLink";
import type { PrivateMemoIdentity } from "@/contexts/PrivateMemoVisibilityContext";
import type { MemoRelation_Memo } from "@/types/proto/api/v1/memo_service_pb";
import RelationPrivacyGuard from "./RelationPrivacyGuard";

interface RelationCardProps {
  memo: Pick<MemoRelation_Memo, "name" | "snippet"> & Partial<PrivateMemoIdentity>;
  parentPage?: string;
  className?: string;
}

const RelationCard = ({ memo, parentPage, className }: RelationCardProps) => {
  const enabled = !useLocation().pathname.startsWith("/memos/shares/");
  const identity =
    typeof memo.mcpHidden === "boolean" ? { name: memo.name, mcpHidden: memo.mcpHidden, updateTime: memo.updateTime } : undefined;
  return (
    <RelationPrivacyGuard memo={identity} enabled={enabled} className={className}>
      <MemoSnippetLink
        name={memo.name}
        snippet={memo.snippet}
        to={`/${memo.name}`}
        state={{ from: parentPage, referenceNavigation: true }}
        className={className}
      />
    </RelationPrivacyGuard>
  );
};

export default RelationCard;
