/**
 * Loads `.jira/.config.ts`, a TypeScript module exporting `config`. It is
 * imported rather than parsed, so the file itself decides where its values
 * come from (including `process.env`) and the tool reads no env vars itself.
 *
 * Cached per path, so callers that already know the config path can load it
 * themselves instead of threading it around. Missing file = all defaults.
 */
import process from "node:process";
import { stat } from "node:fs/promises";

import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError } from "./errors.ts";
import { FRONT_MATTER_KEYS, JIRA_DIR } from "./constants.ts";
import type { FrontMatterKey, IndexColumn } from "./types/jira-local.ts";
import type { JiraLocalConfig } from "./types/config.ts";

/** Sibling of the issues folder, like the state file. */
export function configPath(): string {
  return join(process.cwd(), JIRA_DIR, ".config.ts");
}

const cache = new Map<string, JiraLocalConfig>();

export async function getConfig(): Promise<JiraLocalConfig> {
  const path = configPath();
  const key = pathToFileURL(path).href;
  const cached = cache.get(key);
  if (cached) return cached;
  const config = await loadConfig(path);
  cache.set(key, config);
  return config;
}

async function loadConfig(path: string): Promise<JiraLocalConfig> {
  let isFile = false;
  try {
    isFile = (await stat(path)).isFile();
  } catch {
    isFile = false; // missing or unreadable: defaults apply
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

function validate(
  raw: Record<string, unknown>,
  path: string,
): JiraLocalConfig {
  const label = where(path);

  const site = stringField(raw, "site", label);
  const project = stringField(raw, "project", label);
  const email = stringField(raw, "email", label);
  const token = stringField(raw, "token", label);

  let categoryIndex:
    | Partial<Record<FrontMatterKey, readonly IndexColumn[]>>
    | undefined;
  if (raw.categoryIndex !== undefined) {
    const value = raw.categoryIndex;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ConfigError(`${label}: categoryIndex must be an object`);
    }
    const entries: Partial<Record<FrontMatterKey, readonly IndexColumn[]>> = {};
    for (const [category, columns] of Object.entries(value)) {
      if (!isFrontMatterKey(category)) {
        throw new ConfigError(
          `${label}: categoryIndex key "${category}" is not a front-matter ` +
            `field name — must be one of: ${FRONT_MATTER_KEYS.join(", ")}`,
        );
      }
      if (!Array.isArray(columns) || columns.length === 0) {
        throw new ConfigError(
          `${label}: categoryIndex.${category} must be a non-empty array of ` +
            "column names (omit the key to disable that index)",
        );
      }
      for (const column of columns) {
        if (!isIndexColumn(column)) {
          throw new ConfigError(
            `${label}: categoryIndex.${category} has unknown column ` +
              `"${String(column)}" — must be one of: ` +
              FRONT_MATTER_KEYS.join(", "),
          );
        }
      }
      entries[category] = columns;
    }
    categoryIndex = entries;
  }

  return { site, project, email, token, categoryIndex };
}

function stringField(
  raw: Record<string, unknown>,
  name: string,
  label: string,
): string | undefined {
  const value = raw[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(
      `${label}: ${name} must be a non-empty string (got ${displayOf(value)})`,
    );
  }
  return value;
}

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

function where(path: string): string {
  try {
    const rel = relative(process.cwd(), path);
    return rel === "" ? path : rel;
  } catch {
    return path;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
