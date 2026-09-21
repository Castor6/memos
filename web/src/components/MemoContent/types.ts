import type React from "react";
import type { LinkMetadata } from "@/types/proto/api/v1/memo_service_pb";

export interface MemoContentProps {
  content: string;
  linkMetadata?: LinkMetadata[];
  explicitTags?: boolean;
  displayedTags?: readonly string[];
  maxCharacters?: number;
  /** Resource name of the memo (e.g. `memos/abc123`). Enables footnote links to target the memo detail page. */
  memoName?: string;
  /** The card renders collapsed (ClampedSection), so footnote links navigate instead of scrolling. */
  compact?: boolean;
  className?: string;
  contentClassName?: string;
  onClick?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
}
