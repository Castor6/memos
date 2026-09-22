import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";

const REFRESH_DELAY_MS = 150;
const queues = new WeakMap<QueryClient, { pending: Map<string, QueryKey>; scheduled: boolean }>();

/** Coalesce local writes and live events without repeatedly restarting a running refresh. */
export function scheduleQueryRefresh(client: QueryClient, ...keys: QueryKey[]): void {
  if (keys.length === 0) return;
  let queue = queues.get(client);
  if (!queue) {
    queue = { pending: new Map(), scheduled: false };
    queues.set(client, queue);
  }
  for (const key of keys) queue.pending.set(hashKey(key), key);
  if (queue.scheduled) return;
  queue.scheduled = true;
  const flush = async () => {
    const keys = [...queue.pending.values()];
    const pending = keys.filter(
      (key) => !keys.some((parent) => parent.length < key.length && hashKey(key.slice(0, parent.length)) === hashKey(parent)),
    );
    queue.pending.clear();
    await Promise.allSettled(pending.map((queryKey) => client.invalidateQueries({ queryKey })));
    if (queue.pending.size > 0) {
      setTimeout(flush, REFRESH_DELAY_MS);
    } else {
      queue.scheduled = false;
    }
  };
  setTimeout(flush, REFRESH_DELAY_MS);
}
