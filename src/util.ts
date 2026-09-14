/** Shared helpers for the jira-local tool. */

/** Flatten a Jira display name object (user/project/version) to a string. */
export function displayName(
  value: { displayName?: string; name?: string } | null | undefined,
): string {
  if (!value || typeof value !== "object") return "";
  if (typeof value.displayName === "string") return value.displayName;
  if (typeof value.name === "string") return value.name;
  return "";
}

/** ISO date (yyyy-mm-dd) part of a Jira timestamp, local-safe. */
export function isoDate(value: string | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/** Run async tasks with bounded concurrency, preserving input order in results. */
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

/** Log a progress line to stderr with a local timestamp. */
export function progress(message: string): void {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  console.error(`[${time}] ${message}`);
}
