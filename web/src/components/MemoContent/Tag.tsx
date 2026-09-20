import type { Element } from "hast";
import { useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { type MemoFilter, stringifyFilters, useMemoFilterContext } from "@/contexts/MemoFilterContext";
import useNavigateTo from "@/hooks/useNavigateTo";
import { tagStyles } from "@/lib/markdownStyles";
import { findTagMetadata, getTagStyle } from "@/lib/tag";
import { cn } from "@/lib/utils";
import { Routes } from "@/router";
import { useMemoViewContext } from "../MemoView/MemoViewContext";

interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  node?: Element; // AST node from react-markdown
  "data-tag"?: string;
  children?: React.ReactNode;
}

export const Tag: React.FC<TagProps> = ({ "data-tag": dataTag, children, className, style, node: _node, ...props }) => {
  const { parentPage } = useMemoViewContext();
  const location = useLocation();
  const navigateTo = useNavigateTo();
  const { getFiltersByFactor, removeFilter, addFilter } = useMemoFilterContext();
  const { userTagsSetting } = useAuth();

  const tag = dataTag || "";

  // Custom color from user tag metadata. Dynamic hex values must use inline styles
  // because Tailwind can't scan dynamically constructed class names.
  // Shared styles keep custom colors consistent with editor and filter tags.
  const metadata = userTagsSetting ? findTagMetadata(tag, userTagsSetting) : undefined;
  const customStyle = getTagStyle(metadata);
  const tagStyle = customStyle ? { ...customStyle, ...style } : style;

  const handleTagClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    // If the tag is clicked in a memo detail page, we should navigate to the memo list page.
    if (location.pathname.startsWith("/m")) {
      const pathname = parentPage || Routes.HOME;
      const searchParams = new URLSearchParams();

      searchParams.set("filter", stringifyFilters([{ factor: "tagSearch", value: tag }]));
      navigateTo(`${pathname}?${searchParams.toString()}`);
      return;
    }

    const isActive = getFiltersByFactor("tagSearch").some((filter: MemoFilter) => filter.value === tag);
    if (isActive) {
      removeFilter((f: MemoFilter) => f.factor === "tagSearch" && f.value === tag);
    } else {
      // Remove all existing tag filters first, then add the new one
      removeFilter((f: MemoFilter) => f.factor === "tagSearch");
      addFilter({
        factor: "tagSearch",
        value: tag,
      });
    }
  };

  return (
    <span
      className={cn(
        tagStyles.base,
        "cursor-pointer transition-opacity hover:opacity-75",
        !customStyle && tagStyles.defaultColor,
        className,
      )}
      style={tagStyle}
      data-tag={tag}
      {...props}
      onClick={handleTagClick}
    >
      {metadata?.emoji && (
        <span aria-hidden className="mr-1">
          {metadata.emoji}
        </span>
      )}
      {children}
    </span>
  );
};
