/** Read an env var, treating empty/whitespace-only as unset. */
export function env(name: string): string | undefined {
  const value = Deno.env.get(name);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
