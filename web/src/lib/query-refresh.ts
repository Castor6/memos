import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";

const REFRESH_DELAY_MS = 150;
interface RefreshQueue {
  pending: Map<string, QueryKey>;
  running: Map<string, QueryKey>;
  scheduled: boolean;
}
const queues = new WeakMap<QueryClient, RefreshQueue>();

const isPrefix = (parent: QueryKey, key: QueryKey) =>
  parent.length <= key.length && hashKey(key.slice(0, parent.length)) === hashKey(parent);

function scheduleFlush(client: QueryClient, queue: RefreshQueue) {
  if (queue.scheduled || queue.pending.size === 0) return;
  queue.scheduled = true;
  setTimeout(() => {
    queue.scheduled = false;
    const keys = [...queue.pending.values()];
    const pending = keys.filter((key) => !keys.some((parent) => parent.length < key.length && isPrefix(parent, key)));
    queue.pending = new Map(pending.map((key) => [hashKey(key), key]));
    for (const key of pending) {
      // A broad invalidation shares requests with its child keys. Defer only
      // overlapping work; unrelated queries must not wait for a slow request.
      if ([...queue.running.values()].some((active) => isPrefix(active, key) || isPrefix(key, active))) continue;
      const hash = hashKey(key);
      queue.pending.delete(hash);
      queue.running.set(hash, key);
      void Promise.resolve()
        .then(() => client.invalidateQueries({ queryKey: key }))
        .catch(() => undefined)
        .finally(() => {
          queue.running.delete(hash);
          // Events received in flight need one trailing refresh. Do not poll
          // blocked keys; the matching completion will schedule their retry.
          scheduleFlush(client, queue);
        });
    }
  }, REFRESH_DELAY_MS);
}

/** Coalesce local writes and live events without repeatedly restarting a running refresh. */
export function scheduleQueryRefresh(client: QueryClient, ...keys: QueryKey[]): void {
  if (keys.length === 0) return;
  let queue = queues.get(client);
  if (!queue) {
    queue = { pending: new Map(), running: new Map(), scheduled: false };
    queues.set(client, queue);
  }
  for (const key of keys) queue.pending.set(hashKey(key), key);
  scheduleFlush(client, queue);
}
