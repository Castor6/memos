import { createContext, useContext } from "react";

// True while the layout's visible explorer is still loading its calendar and
// tag statistics. Pages outside MainLayout see the default and never wait.
const MemoExplorerLoadingContext = createContext(false);

export const MemoExplorerLoadingProvider = MemoExplorerLoadingContext.Provider;

export function useMemoExplorerLoading() {
  return useContext(MemoExplorerLoadingContext);
}
