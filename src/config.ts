/**
 * User configuration: `.jira/config.ts` (sibling of the issues folder), a
 * TypeScript module exporting a `config` object typed as `JiraLocalConfig`.
 *
 * Loaded lazily by `getConfig` and cached per resolved path for the lifetime
 * of the process, so callers that already know the issues folder can pull the
 * config themselves instead of it being threaded through parameters. A missing
 * config file is not an error: the defaults (no filtering) apply. A malformed
 * config — bad export, wrong shapes, folder names or columns that are not
 * front-matter field names — raises a `ConfigError` and aborts the run before
 * any writing happens. The two fields are independent: `categoryIndex` may
 * list folders that `categoryFolders` does not (index pages without symlink
 * folders).
 */

import { stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError } from "./errors.ts";
import { FRONT_MATTER_KEYS } from "./constants.ts";
import type { FrontMatterKey, IndexColumn, JiraLocalConfig } from "./types.ts";

/** Path of the config file, sibling of the issues folder (like the state file). */
export function configPath(outDir: string): string {
  const grandParent = dirname(dirname(outDir)); // .jira, sibling of issues/
  return join(grandParent, "config.ts");
}

/** Loaded configs, keyed by resolved config-file path. */
const cache = new Map<string, JiraLocalConfig>();

/**
 * Load and validate the config for the issues folder `allDir`. Cached after
 * the first call; missing file yields the empty config (all defaults).
 */
export async function getConfig(allDir: string): Promise<JiraLocalConfig> {
  const path = configPath(allDir);
  const key = pathToFileURL(path).href;
  const cached = cache.get(key);
  if (cached) return cached;
  const config = await loadConfig(path);
  cache.set(key, config);
  return config;
}

/** Load the config file, or the empty config when it does not exist. */
async function loadConfig(path: string): Promise<JiraLocalConfig> {
  let isFile = false;
  try {
    isFile = (await stat(path)).isFile();
  } catch {
    isFile = false; // missing (or unreadable): use defaults
  }
  if (!isFile) return {};

  let imported: Record<string, unknown>;
  try {
    imported = await import(pathToFileURL(path).href);
  } catch (error) {
    throw new ConfigError(
      `${where(path)} failed to load: ${messageOf(error)}`,
      { cause: error },
    );
  }
  const config = imported.config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new ConfigError(
      `${where(path)} must export \`config\` as an object ` +
        "(add `export` to the config declaration)",
    );
  }
  return validate(config as Record<string, unknown>, path);
}

/** Validate the raw config shape; unknown/extra fields are ignored. */
function validate(
  raw: Record<string, unknown>,
  path: string,
): JiraLocalConfig {
  const label = where(path);

  let categoryFolders: readonly FrontMatterKey[] | undefined;
  if (raw.categoryFolders !== undefined) {
    const value = raw.categoryFolders;
    if (!Array.isArray(value)) {
      throw new ConfigError(
        `${label}: categoryFolders must be an array of front-matter field ` +
          `names (${FRONT_MATTER_KEYS.join(", ")})`,
      );
    }
    categoryFolders = value.map((entry, index) => {
      if (!isFrontMatterKey(entry)) {
        throw new ConfigError(
          `${label}: categoryFolders[${index}] is ${displayOf(entry)} — ` +
            "must be a front-matter field name: " +
            FRONT_MATTER_KEYS.join(", "),
        );
      }
      return entry;
    });
  }

  let categoryIndex:
    | Partial<Record<FrontMatterKey, readonly IndexColumn[]>>
    | undefined;
  if (raw.categoryIndex !== undefined) {
    const value = raw.categoryIndex;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ConfigError(`${label}: categoryIndex must be an object`);
    }
    const entries: Partial<Record<FrontMatterKey, readonly IndexColumn[]>> = {};
    for (const [folder, columns] of Object.entries(value)) {
      if (!isFrontMatterKey(folder)) {
        throw new ConfigError(
          `${label}: categoryIndex key "${folder}" is not a front-matter ` +
            `field name — must be one of: ${FRONT_MATTER_KEYS.join(", ")}`,
        );
      }
      if (!Array.isArray(columns) || columns.length === 0) {
        throw new ConfigError(
          `${label}: categoryIndex.${folder} must be a non-empty array of ` +
            "column names (omit the key to disable that index)",
        );
      }
      for (const column of columns) {
        if (!isIndexColumn(column)) {
          throw new ConfigError(
            `${label}: categoryIndex.${folder} has unknown column ` +
              `"${String(column)}" — must be one of: ` +
              FRONT_MATTER_KEYS.join(", "),
          );
        }
      }
      entries[folder] = columns;
    }
    categoryIndex = entries;
  }

  return { categoryFolders, categoryIndex };
}

/** Check whether a value is a front-matter field name (folder/column vocabulary). */
export function isFrontMatterKey(value: unknown): value is FrontMatterKey {
  return (
    typeof value === "string" &&
    (FRONT_MATTER_KEYS as readonly string[]).includes(value)
  );
}

function isIndexColumn(value: unknown): value is IndexColumn {
  return isFrontMatterKey(value);
}

function displayOf(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

/** The config path relative to the CWD, for friendlier error messages. */
function where(path: string): string {
  try {
    const rel = relative(Deno.cwd(), path);
    return rel === "" ? path : rel;
  } catch {
    return path;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
