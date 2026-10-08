/** Users, projects and versions all spell their name differently. */
export function displayName(
  value: { displayName?: string; name?: string } | null | undefined,
): string {
  if (!value || typeof value !== "object") return "";
  if (typeof value.displayName === "string") return value.displayName;
  if (typeof value.name === "string") return value.name;
  return "";
}

export function isoDate(value: string | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/** Bounded concurrency, results in input order. */
export async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    {
      length: Math.max(1, Math.min(concurrency, items.length)),
    },
    () =>
      (async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          const item = items[index];
          if (item === undefined) return;
          results[index] = await task(item, index);
        }
      })(),
  );
  await Promise.all(workers);
  return results;
}

export function pluralise(n: number, one: string, many: string): string {
  return n === 1 ? `${n} ${one}` : `${n} ${many}`;
}

export function elapsed(started: number): string {
  const secs = (Date.now() - started) / 1000;
  return secs >= 10 ? `${secs.toFixed(0)}s` : `${secs.toFixed(1)}s`;
}
