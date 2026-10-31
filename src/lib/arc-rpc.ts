import { http } from "viem";

type HttpFetch = NonNullable<NonNullable<Parameters<typeof http>[1]>["fetchFn"]>;
type Queue = { tail: Promise<void>; nextAt: number };
const queues = new Map<string, Queue>();

/** Share a bounded HTTP queue across all Arc clients in this process. */
export function arcRpcTransport(url: string) {
  let existing = queues.get(url);
  if (!existing) { existing = { tail: Promise.resolve(), nextAt: 0 }; queues.set(url, existing); }
  return queuedTransport(url, existing);
}

/** A Worker refresh owns its I/O queue; no promises cross request contexts. */
export function isolatedArcRpcTransport(url: string) {
  return queuedTransport(url, { tail: Promise.resolve(), nextAt: 0 });
}

function queuedTransport(url: string, queue: Queue) {
  const fetchFn: HttpFetch = (...args) => {
    const result = queue.tail.then(async () => {
      const delay = queue.nextAt - Date.now();
      if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
      queue.nextAt = Date.now() + 500;
      return fetch(...args);
    });
    queue.tail = result.then(() => undefined, () => undefined);
    return result;
  };
  return http(url, { batch: { batchSize: 10, wait: 20 }, timeout: 30000, retryCount: 4, retryDelay: 2000, fetchFn });
}
