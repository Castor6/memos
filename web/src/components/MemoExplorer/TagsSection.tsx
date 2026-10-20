import { HashIcon, MoreVerticalIcon, TagsIcon } from "lucide-react";
import { useState } from "react";
import TagSettingsMenu, { TagSettingsDialog } from "@/components/TagSettingsMenu";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/contexts/AuthContext";
import { type MemoFilter, useMemoFilterContext } from "@/contexts/MemoFilterContext";
import { useLocalStorage } from "@/hooks";
import { findTagMetadata, getTagStyle } from "@/lib/tag";
import { cn } from "@/lib/utils";
import { useTranslate } from "@/utils/i18n";
import TagTree from "../TagTree";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

interface Props {
  readonly?: boolean;
  tagCount: Record<string, number>;
}

const TagsSection = (props: Props) => {
  const t = useTranslate();
  const { currentUser, userTagsSetting } = useAuth();
  const { getFiltersByFactor, addFilter, removeFilter, tagMatchMode, setTagMatchMode } = useMemoFilterContext();
  const [treeMode, setTreeMode] = useLocalStorage<boolean>("tag-view-as-tree", false);
  const [treeAutoExpand, setTreeAutoExpand] = useLocalStorage<boolean>("tag-tree-auto-expand", false);

  const [optionsOpen, setOptionsOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  const tags = Object.entries(props.tagCount)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .sort((a, b) => b[1] - a[1]);

  const handleTagClick = (tag: string) => {
    const isActive = getFiltersByFactor("tagSearch").some((filter: MemoFilter) => filter.value === tag);
    if (isActive) {
      removeFilter((f: MemoFilter) => f.factor === "tagSearch" && f.value === tag);
    } else {
      addFilter({
        factor: "tagSearch",
        value: tag,
      });
    }
  };

  return (
    <div className="w-full flex flex-col justify-start items-start mt-3 px-1 h-auto shrink-0 flex-nowrap">
      <div className="flex flex-row justify-between items-center w-full gap-1 mb-1 text-sm leading-6 text-muted-foreground select-none">
        <span className="mr-auto">{t("common.tags")}</span>
        <Select value={tagMatchMode} onValueChange={(value) => setTagMatchMode(value === "all" ? "all" : "any")}>
          <SelectTrigger size="sm" aria-label={t("memo.filters.tag-mode")}>
            <SelectValue>{t(tagMatchMode === "all" ? "memo.filters.intersection" : "memo.filters.union")}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            <SelectGroup>
              <SelectItem value="any" indicator={false}>
                {t("memo.filters.union")}
              </SelectItem>
              <SelectItem value="all" indicator={false}>
                {t("memo.filters.intersection")}
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        {(tags.length > 0 || currentUser) && (
          <Popover open={optionsOpen} onOpenChange={setOptionsOpen}>
            <PopoverTrigger aria-label="标签菜单">
              <MoreVerticalIcon className="w-4 h-auto shrink-0 text-muted-foreground cursor-pointer hover:text-foreground" />
            </PopoverTrigger>
            <PopoverContent align="end" alignOffset={-12}>
              <div className="w-auto flex flex-row justify-between items-center gap-2 p-1">
                <span className="text-sm shrink-0">{t("common.tree-mode")}</span>
                <Switch checked={treeMode} onCheckedChange={(checked) => setTreeMode(checked)} />
              </div>
              <div className="w-auto flex flex-row justify-between items-center gap-2 p-1">
                <span className="text-sm shrink-0">{t("common.auto-expand")}</span>
                <Switch disabled={!treeMode} checked={treeAutoExpand} onCheckedChange={(checked) => setTreeAutoExpand(checked)} />
              </div>
              {currentUser && (
                <Button
                  variant="ghost"
                  className="w-full"
                  onClick={() => {
                    setOptionsOpen(false);
                    setManageOpen(true);
                  }}
                >
                  管理标签规则
                </Button>
              )}
            </PopoverContent>
          </Popover>
        )}
      </div>
      <TagSettingsDialog open={manageOpen} onOpenChange={setManageOpen} />
      {tags.length > 0 ? (
        treeMode ? (
          <TagTree tagAmounts={tags} expandSubTags={!!treeAutoExpand} />
        ) : (
          <div className="w-full flex flex-col justify-start items-stretch relative gap-1">
            {tags.map(([tag, amount]) => {
              const metadata = userTagsSetting ? findTagMetadata(tag, userTagsSetting) : undefined;
              const emoji = metadata?.emoji;
              const isActive = getFiltersByFactor("tagSearch").some((filter: MemoFilter) => filter.value === tag);
              return (
                <TagSettingsMenu key={tag} tag={tag}>
                  <button
                    type="button"
                    aria-pressed={isActive}
                    className={cn(
                      "shrink-0 w-auto max-w-full text-sm rounded-md leading-6 flex flex-row justify-start items-center select-none cursor-pointer transition-colors",
                      "hover:opacity-80",
                      isActive ? "text-primary bg-accent/60" : "text-muted-foreground",
                    )}
                    onClick={() => handleTagClick(tag)}
                    data-sidebar-tag={tag}
                    style={getTagStyle(metadata)}
                  >
                    {emoji ? <span>{emoji}</span> : <HashIcon className="w-4 h-auto shrink-0" />}
                    <div className="inline-flex flex-nowrap ml-0.5 gap-0.5 max-w-[calc(100%-16px)]">
                      <span className={cn("truncate", isActive ? "font-medium" : "")}>{tag}</span>
                      {amount > 1 && <span className="opacity-60 shrink-0">({amount})</span>}
                    </div>
                  </button>
                </TagSettingsMenu>
              );
            })}
          </div>
        )
      ) : (
        !props.readonly && (
          <div className="p-2 border border-dashed rounded-md flex flex-row justify-start items-start gap-2 text-muted-foreground">
            <TagsIcon className="w-5 h-5 shrink-0" />
            <p className="text-sm leading-snug italic">{t("tag.create-tags-guide")}</p>
          </div>
        )
      )}
    </div>
  );
};

export default TagsSection;
