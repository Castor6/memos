import { useCallback, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import MemoEditor from "@/components/MemoEditor";
import { deriveDefaultCreateTimeFromFilters } from "@/components/MemoEditor/utils/deriveDefaultCreateTime";
import MemoView from "@/components/MemoView";
import PagedMemoList, { getMemoKey } from "@/components/PagedMemoList";
import StartupReady from "@/components/StartupReady";
import { useMemoExplorerLoading } from "@/contexts/MemoExplorerLoadingContext";
import { useMemoFilterContext } from "@/contexts/MemoFilterContext";
import { NewMemoProvider } from "@/contexts/NewMemoContext";
import { useMemoFilters, useMemoSorting } from "@/hooks";
import useCurrentUser from "@/hooks/useCurrentUser";
import { State } from "@/types/proto/api/v1/common_pb";
import { Memo } from "@/types/proto/api/v1/memo_service_pb";
import { useTranslate } from "@/utils/i18n";

const Home = ({ isTodo = false }: { isTodo?: boolean }) => {
  const user = useCurrentUser();
  const location = useLocation();
  const t = useTranslate();
  const { filters } = useMemoFilterContext();
  const defaultCreateTime = useMemo(() => deriveDefaultCreateTimeFromFilters(filters), [filters]);
  const explorerLoading = useMemoExplorerLoading();
  const [listReady, setListReady] = useState(false);
  const markListReady = useCallback(() => setListReady(true), []);

  const memoFilter = useMemoFilters({
    isTodo,
    creatorName: user?.name,
    includeShortcuts: true,
    includePinned: true,
  });

  const { listSort, orderBy } = useMemoSorting({
    pinnedFirst: true,
    state: State.NORMAL,
  });

  return (
    <div className="w-full min-h-full bg-background text-foreground">
      {/* Reveal the sidebar statistics, composer, and first memo page together. */}
      <StartupReady pending={!listReady || explorerLoading} />
      <NewMemoProvider>
        <PagedMemoList
          isTodo={isTodo}
          onContentReady={markListReady}
          renderer={(memo: Memo, { compact }) => (
            <MemoView
              key={getMemoKey(memo)}
              memo={memo}
              parentPage={`${location.pathname}${location.search}`}
              showVisibility
              showPinned
              compact={compact}
            />
          )}
          listSort={listSort}
          orderBy={orderBy}
          filter={memoFilter}
          renderLeading={({ useGrid }) => (
            <MemoEditor
              key={isTodo ? "todo-editor" : "memo-editor"}
              isTodo={isTodo}
              className={useGrid ? undefined : "mb-2"}
              cacheKey={isTodo ? "todo-editor" : "home-memo-editor"}
              placeholder={isTodo ? "写下待办事项…" : t("editor.any-thoughts")}
              defaultCreateTime={defaultCreateTime}
            />
          )}
        />
      </NewMemoProvider>
    </div>
  );
};

export default Home;
