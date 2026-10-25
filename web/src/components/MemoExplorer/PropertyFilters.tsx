import { EyeIcon, ListTodoIcon, ShieldOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type MemoFilter, useMemoFilterContext } from "@/contexts/MemoFilterContext";
import { usePrivateMemoVisibility } from "@/contexts/PrivateMemoVisibilityContext";
import { useTranslate } from "@/utils/i18n";

const PropertyFilters = () => {
  const t = useTranslate();
  const { hasFilter, addFilter, removeFiltersByFactor } = useMemoFilterContext();
  const { showAll, toggleAll } = usePrivateMemoVisibility();
  const incompleteFilter: MemoFilter = { factor: "property.hasIncompleteTasks", value: "true" };
  const privateFilter: MemoFilter = { factor: "mcpHidden", value: "true" };
  const toggleFilter = (filter: MemoFilter) => (hasFilter(filter) ? removeFiltersByFactor(filter.factor) : addFilter(filter));
  const visibilityLabel = t(showAll ? "memo.mcp-privacy.hide-all" : "memo.mcp-privacy.show-all");

  return (
    <div className="mt-3 flex flex-wrap gap-2 px-1" role="group" aria-label={t("memo.filters.label")}>
      <Button variant="filter" size="sm" aria-pressed={hasFilter(incompleteFilter)} onClick={() => toggleFilter(incompleteFilter)}>
        <ListTodoIcon data-icon="inline-start" />
        {t("memo.filters.incomplete")}
      </Button>
      <div
        role="group"
        aria-label={t("memo.mcp-privacy.label")}
        className="inline-flex h-7 items-center rounded-full border border-border bg-card shadow-xs"
      >
        <Button
          variant="filter-segment"
          size="sm"
          className="h-full rounded-s-full rounded-e-none"
          aria-pressed={hasFilter(privateFilter)}
          onClick={() => toggleFilter(privateFilter)}
        >
          <ShieldOffIcon data-icon="inline-start" />
          {t("memo.mcp-privacy.label")}
        </Button>
        <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="filter-segment"
                size="sm"
                className="h-full w-8 rounded-s-none rounded-e-full px-0 has-[>svg]:px-0"
                aria-label={visibilityLabel}
                aria-pressed={showAll}
                onClick={toggleAll}
              />
            }
          >
            <EyeIcon />
          </TooltipTrigger>
          <TooltipContent>{visibilityLabel}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
};

export default PropertyFilters;
