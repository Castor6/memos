import { useQueries, useQueryClient } from "@tanstack/react-query";
import { findMemoInCollectionQueries, memoDetailQueryOptions } from "@/hooks/useMemoQueries";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";

export const useResolvedRelationMemos = (memoNames: string[], options?: { enabled?: boolean }) => {
  const queryClient = useQueryClient();
  const names = Array.from(new Set(memoNames)).filter(Boolean);
  const queries = useQueries({
    queries: names.map((name) => ({
      ...memoDetailQueryOptions(name),
      initialData: () => findMemoInCollectionQueries(queryClient, name),
      enabled: options?.enabled ?? true,
    })),
  });
  const resolved: Record<string, Memo> = {};
  queries.forEach((query, index) => {
    if (query.data) resolved[names[index]] = query.data;
  });
  return resolved;
};
