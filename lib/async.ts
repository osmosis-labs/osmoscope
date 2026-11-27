// Run `fn` over `items` with at most `limit` invocations in flight at once,
// preserving input order. Shared across validator fan-outs, treasury snapshot
// queries, and archive backfill scripts so none hand-roll their own worker pool.
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker)
  );
  return results;
}
