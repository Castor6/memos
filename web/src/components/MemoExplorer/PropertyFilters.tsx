import { ListTodoIcon, ShieldOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type MemoFilter, useMemoFilterContext } from "@/contexts/MemoFilterContext";
import { useTranslate } from "@/utils/i18n";

const PropertyFilters = () => {
  const t = useTranslate();
  const { hasFilter, addFilter, removeFiltersByFactor } = useMemoFilterContext();
  const options = [
    { factor: "property.hasIncompleteTasks", label: t("memo.filters.incomplete"), icon: ListTodoIcon },
    { factor: "mcpHidden", label: t("memo.mcp-privacy.label"), icon: ShieldOffIcon },
  ] as const;

  return (
    <div className="mt-3 flex flex-wrap gap-2 px-1" role="group" aria-label={t("memo.filters.label")}>
      {options.map(({ factor, label, icon: Icon }) => {
        const filter: MemoFilter = { factor, value: "true" };
        const active = hasFilter(filter);
        return (
          <Button
            key={factor}
            variant="filter"
            size="sm"
            aria-pressed={active}
            onClick={() => (active ? removeFiltersByFactor(factor) : addFilter(filter))}
          >
            <Icon data-icon="inline-start" />
            {label}
          </Button>
        );
      })}
    </div>
  );
};

export default PropertyFilters;
