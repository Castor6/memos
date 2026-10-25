import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";

interface PrivateMemoVisibility {
  showAll: boolean;
  revealed: ReadonlySet<string>;
  toggleAll: () => void;
  reveal: (key: string) => void;
  forget: (name: string) => void;
}

const PrivateMemoVisibilityContext = createContext<PrivateMemoVisibility | null>(null);

export function PrivateMemoVisibilityProvider({ children }: { children: ReactNode }) {
  // Disclosure is deliberately session-only: never persist it in browser storage.
  const [state, setState] = useState(() => ({ showAll: false, revealed: new Set<string>() }));
  const toggleAll = useCallback(() => {
    setState((previous) => ({ showAll: !previous.showAll, revealed: new Set<string>() }));
  }, []);
  const reveal = useCallback((key: string) => {
    setState((previous) => {
      if (previous.revealed.has(key)) return previous;
      return { ...previous, revealed: new Set(previous.revealed).add(key) };
    });
  }, []);
  const forget = useCallback((name: string) => {
    setState((previous) => {
      const revealed = new Set([...previous.revealed].filter((key) => !key.startsWith(`${name}:`)));
      return revealed.size === previous.revealed.size ? previous : { ...previous, revealed };
    });
  }, []);
  const value = useMemo(() => ({ ...state, toggleAll, reveal, forget }), [state, toggleAll, reveal, forget]);
  return <PrivateMemoVisibilityContext.Provider value={value}>{children}</PrivateMemoVisibilityContext.Provider>;
}

export function usePrivateMemoVisibility() {
  const context = useContext(PrivateMemoVisibilityContext);
  if (!context) throw new Error("usePrivateMemoVisibility must be used within PrivateMemoVisibilityProvider");
  return context;
}

export type PrivateMemoIdentity = Pick<Memo, "name" | "mcpHidden" | "updateTime">;

export function useMemoPrivacy(memo: PrivateMemoIdentity) {
  const context = useContext(PrivateMemoVisibilityContext);
  const [localKey, setLocalKey] = useState<string>();
  const forget = context?.forget;
  useEffect(() => {
    if (!memo.mcpHidden) {
      forget?.(memo.name);
      setLocalKey(undefined);
    }
  }, [memo.mcpHidden, memo.name, forget]);
  // Re-edited or newly protected content must not reuse an earlier disclosure.
  const key = `${memo.name}:${memo.updateTime?.seconds ?? ""}:${memo.updateTime?.nanos ?? ""}`;
  const revealed = context ? context.showAll || context.revealed.has(key) : localKey === key;
  const reveal = () => (context ? context.reveal(key) : setLocalKey(key));
  return { hidden: memo.mcpHidden && !revealed, reveal };
}
