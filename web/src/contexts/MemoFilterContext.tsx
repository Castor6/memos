import { uniqBy } from "lodash-es";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

export type FilterFactor =
  | "tagSearch"
  | "visibility"
  | "contentSearch"
  | "displayTime"
  | "pinned"
  | "property.hasLink"
  | "property.hasTaskList"
  | "property.hasCode"
  | "property.hasIncompleteTasks"
  | "mcpHidden";

export type TagMatchMode = "any" | "all";

export interface MemoFilter {
  factor: FilterFactor;
  value: string;
}

export const getMemoFilterKey = (filter: MemoFilter): string => `${filter.factor}:${filter.value}`;

export const parseFilterQuery = (query: string | null): MemoFilter[] => {
  if (!query) return [];
  try {
    return query.split(",").map((filterStr) => {
      const [factor, value] = filterStr.split(":");
      return {
        factor: factor as FilterFactor,
        value: decodeURIComponent(value || ""),
      };
    });
  } catch {
    return [];
  }
};

export const stringifyFilters = (filters: MemoFilter[]): string => {
  return filters.map((filter) => `${filter.factor}:${encodeURIComponent(filter.value)}`).join(",");
};

interface MemoFilterContextValue {
  filters: MemoFilter[];
  tagMatchMode: TagMatchMode;
  setTagMatchMode: (mode: TagMatchMode) => void;
  shortcut: string | undefined;
  hasActiveFilters: boolean;
  getFiltersByFactor: (factor: FilterFactor) => MemoFilter[];
  setFilters: (filters: MemoFilter[]) => void;
  addFilter: (filter: MemoFilter) => void;
  removeFilter: (predicate: (f: MemoFilter) => boolean) => void;
  removeFiltersByFactor: (factor: FilterFactor) => void;
  clearAllFilters: () => void;
  setShortcut: (shortcut?: string) => void;
  hasFilter: (filter: MemoFilter) => boolean;
}

const MemoFilterContext = createContext<MemoFilterContextValue | null>(null);

export function MemoFilterProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams();
  // Keep the URL authoritative, including external navigation and browser history.
  // The ref also accumulates multiple updates made in one event (e.g. search words).
  const pendingParams = useRef(searchParams);
  pendingParams.current = searchParams;
  const filters = useMemo(() => parseFilterQuery(searchParams.get("filter")), [searchParams]);
  const tagMatchMode: TagMatchMode = searchParams.get("tagMode") === "all" ? "all" : "any";
  const [shortcut, setShortcutState] = useState<string | undefined>(undefined);

  const updateParams = useCallback(
    (update: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(pendingParams.current);
      update(params);
      pendingParams.current = params;
      setSearchParams(params, { replace: true });
    },
    [setSearchParams],
  );

  const updateFilters = useCallback(
    (update: (previous: MemoFilter[]) => MemoFilter[]) => {
      updateParams((params) => {
        const next = uniqBy(update(parseFilterQuery(params.get("filter"))), getMemoFilterKey);
        if (next.length > 0) params.set("filter", stringifyFilters(next));
        else params.delete("filter");
        if (!next.some((filter) => filter.factor === "tagSearch")) params.delete("tagMode");
      });
    },
    [updateParams],
  );

  const setTagMatchMode = useCallback(
    (mode: TagMatchMode) => {
      updateParams((params) => {
        if (mode === "all") params.set("tagMode", mode);
        else params.delete("tagMode");
      });
    },
    [updateParams],
  );

  const getFiltersByFactor = useCallback((factor: FilterFactor) => filters.filter((f) => f.factor === factor), [filters]);
  const setFilters = useCallback((next: MemoFilter[]) => updateFilters(() => next), [updateFilters]);
  const addFilter = useCallback((filter: MemoFilter) => updateFilters((previous) => [...previous, filter]), [updateFilters]);
  const removeFilter = useCallback(
    (predicate: (f: MemoFilter) => boolean) => updateFilters((previous) => previous.filter((f) => !predicate(f))),
    [updateFilters],
  );
  const removeFiltersByFactor = useCallback((factor: FilterFactor) => removeFilter((f) => f.factor === factor), [removeFilter]);

  const clearAllFilters = useCallback(() => {
    setFilters([]);
    setShortcutState(undefined);
  }, [setFilters]);

  const setShortcut = useCallback(
    (newShortcut?: string) => {
      setShortcutState(newShortcut);
      // Clear content search filter when selecting a shortcut (issue #5462).
      if (newShortcut !== undefined) removeFiltersByFactor("contentSearch");
    },
    [removeFiltersByFactor],
  );

  const hasFilter = useCallback((filter: MemoFilter) => filters.some((f) => getMemoFilterKey(f) === getMemoFilterKey(filter)), [filters]);

  const hasActiveFilters = filters.length > 0 || shortcut !== undefined;

  return (
    <MemoFilterContext.Provider
      value={{
        filters,
        tagMatchMode,
        setTagMatchMode,
        shortcut,
        hasActiveFilters,
        getFiltersByFactor,
        setFilters,
        addFilter,
        removeFilter,
        removeFiltersByFactor,
        clearAllFilters,
        setShortcut,
        hasFilter,
      }}
    >
      {children}
    </MemoFilterContext.Provider>
  );
}

export function useMemoFilterContext() {
  const context = useContext(MemoFilterContext);
  if (!context) {
    throw new Error("useMemoFilterContext must be used within MemoFilterProvider");
  }
  return context;
}

// Alias for backwards compatibility during migration
export const useMemoFilter = useMemoFilterContext;

const NO_TERMS: string[] = [];

/**
 * The words of the active plain-text search, in the order the user typed them. Safe outside a
 * provider (share previews, tests), where there is no search and therefore nothing to match.
 */
export function useContentSearchTerms(): string[] {
  const filters = useContext(MemoFilterContext)?.filters;
  return useMemo(() => {
    const terms = (filters ?? []).filter((filter) => filter.factor === "contentSearch").map((filter) => filter.value);
    return terms.length > 0 ? terms : NO_TERMS;
  }, [filters]);
}
