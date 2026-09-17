/**
 * The `init` command: create a default `.jira/.config.ts` next to the issues
 * folder, refusing to touch an existing one. Interactive by default: prompts
 * for the site (full URL, domain, or bare site prefix — normalised), the
 * project key directly, and for email/token either a direct value or an
 * env-var name; skipped inputs keep the template defaults. `--yes/-y` (or a
 * non-TTY stdin) skips the prompts; connection flags prefill and skip their
 * prompt.
 */

import { Command, ValidationError } from "@cliffy/command";
import { Input, Select } from "@cliffy/prompt";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { configPath, getConfig } from "../config.ts";

/** A connection field sourced directly or from an env var. */
type FieldValue = { kind: "literal"; value: string } | {
  kind: "env";
  name: string;
};

/** The connection fields written into the config template. */
interface Connection {
  site: string;
  project?: FieldValue;
  email?: FieldValue;
  token?: FieldValue;
}

export interface InitOptions {
  site?: string;
  project?: string;
  email?: string;
  token?: string;
  yes?: boolean;
}

const DEFAULT_SITE = "https://your-site.atlassian.net";

export function initCommand() {
  return new Command()
    .description(
      "Create a default .jira/.config.ts (sibling of the issues folder).\n" +
        "Refuses to overwrite an existing config. Prompts interactively\n" +
        "unless --yes/-y is passed (prompts are also skipped when stdin is\n" +
        "not a terminal); connection flags prefill and skip their prompt.",
    )
    .option(
      "--out <dir:string>",
      "Output directory, relative to the project root.",
      { default: ".jira/issues/all" },
    )
    .option(
      "--site <url:string>",
      "Write this Jira Cloud base URL into the config (URL, domain, or site prefix).",
    )
    .option("--project <key:string>", "Write this project key into the config.")
    .option(
      "--email <email:string>",
      "Write this Atlassian account email into the config.",
    )
    .option(
      "--token <secret:string>",
      "Write this Atlassian API token into the config.",
    )
    .option("-y, --yes", "Skip the prompts; use the flags or the defaults.")
    .action((options) => {
      return runInit(options.out, {
        site: options.site,
        project: options.project,
        email: options.email,
        token: options.token,
        yes: options.yes,
      });
    });
}

export async function runInit(
  out: string,
  options: InitOptions,
): Promise<void> {
  const outDir = resolve(Deno.cwd(), out);
  const config = configPath(outDir);

  await mkdir(dirname(config), { recursive: true });

  let isFile = false;
  try {
    isFile = (await Deno.stat(config)).isFile;
  } catch {
    isFile = false;
  }
  if (isFile) {
    throw new ValidationError(
      `${display(config)} already exists — edit it instead of re-running init`,
      { exitCode: 1 },
    );
  }

  const interactive = !options.yes && Deno.stdin.isTerminal();
  if (!options.yes && !interactive) warnNoTty();

  const connection: Connection = {
    site: options.site === undefined
      ? DEFAULT_SITE
      : normalizeSite(options.site),
    project: literal(options.project),
    email: literal(options.email),
    token: literal(options.token),
  };

  if (interactive) {
    if (options.site === undefined) connection.site = await promptSite();
    if (options.project === undefined) {
      connection.project = await promptProject();
    }
    if (options.email === undefined) {
      connection.email = await promptField("email", "JIRA_EMAIL", true);
    }
    if (options.token === undefined) {
      connection.token = await promptField("token", "JIRA_API_TOKEN", true);
    }
  }

  await writeFile(config, template(connection));
  // Prove the written file loads and validates (category fields are valid).
  await getConfig(outDir);

  const provided: string[] = [];
  if (connection.site !== DEFAULT_SITE) provided.push("site");
  if (connection.project !== undefined) provided.push("project");
  if (connection.email !== undefined) provided.push("email");
  if (connection.token !== undefined) provided.push("token");
  const remaining = ["site", "project", "email", "token"].filter(
    (field) => !provided.includes(field),
  );
  console.log(
    `Created ${display(config)} — ${
      provided.length > 0 ? `set ${provided.join("/")}; ` : ""
    }${
      remaining.length === 0
        ? "connection settings complete, run deno task jira-local pull."
        : `kept the defaults for ${
          remaining.join("/")
        } — set them in the config, then run deno task jira-local pull.`
    }`,
  );
}

/** Literal flag value, or undefined when absent/blank (leaves the default). */
function literal(value: string | undefined): FieldValue | undefined {
  const trimmed = value?.trim();
  return trimmed ? { kind: "literal", value: trimmed } : undefined;
}

/** Normalise a site input: URL, bare domain, or site prefix → base URL origin. */
function normalizeSite(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") {
    throw new ValidationError("site must be a non-empty string");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ValidationError(
      `"${raw}" is not a valid site URL or domain (e.g. https://example.atlassian.net)`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ValidationError(
      `"${raw}" uses the "${url.protocol}" scheme — expected http(s)`,
    );
  }
  if (!url.hostname.includes(".")) {
    url.hostname = `${url.hostname}.atlassian.net`;
  }
  return url.origin;
}

/** Ask for the site; an empty answer keeps the template placeholder. */
async function promptSite(): Promise<string> {
  while (true) {
    const answer = (
      await Input.prompt({
        message: "Atlassian site (full URL, domain, or site prefix)",
        default: DEFAULT_SITE,
      })
    ).trim();
    try {
      return normalizeSite(answer);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

/** Ask for the project key; an empty answer keeps the template placeholder. */
async function promptProject(): Promise<FieldValue | undefined> {
  const value = (await Input.prompt({ message: "Project key (Enter to skip)" }))
    .trim();
  return value === "" ? undefined : { kind: "literal", value };
}

/**
 * Ask how to source one connection field: a direct value, an env var (whose
 * name can be customised), or the template default. Empty value input skips.
 */
async function promptField(
  name: string,
  envVar: string,
  preferEnv: boolean,
): Promise<FieldValue | undefined> {
  const how = await Select.prompt({
    message: `${capitalise(name)} — source it via`,
    options: [
      { name: "Direct value", value: "literal" },
      { name: `Env var (default ${envVar})`, value: "env" },
      { name: "Skip — keep the template default", value: "skip" },
    ],
    default: preferEnv ? "env" : "skip",
  });
  if (how === "skip") return undefined;
  if (how === "env") return { kind: "env", name: await promptEnvName(envVar) };
  const value = (await Input.prompt({ message: `${name} (Enter to skip)` }))
    .trim();
  return value === "" ? undefined : { kind: "literal", value };
}

/** Ask for an env var name; an empty answer keeps the default name. */
async function promptEnvName(fallback: string): Promise<string> {
  while (true) {
    const answer = (
      await Input.prompt({
        message: `Env var name (Enter for ${fallback})`,
        default: fallback,
      })
    ).trim();
    if (answer === "" || answer === fallback) return fallback;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(answer)) return answer;
    console.error(`"${answer}" is not a valid env var name — try again.`);
  }
}

function warnNoTty(): boolean {
  console.warn(
    "stdin is not a terminal — skipping prompts (pass --yes to skip them explicitly)",
  );
  return true;
}

function capitalise(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function template(connection: Connection): string {
  // The written config imports the config type from the package root
  // (mod.ts). Locally that is a relative path into the repo; when running
  // from a published package (jsr.io URL) refer to the package itself, so
  // the import survives version bumps.
  let types = import.meta.resolve("../src/mod.ts");
  if (types.startsWith("file:")) types = "../src/mod.ts";
  const published = /https:\/\/jsr\.io\/(@[^/]+)\/([^@/]+)@[^/]+\//.exec(types);
  if (published) types = `jsr:${published[1]}/${published[2]}`;

  return `import type { JiraLocalConfig } from ${JSON.stringify(types)};

export const config: JiraLocalConfig = {
  site: ${JSON.stringify(connection.site)},
  project: ${fieldTemplate(connection.project, JSON.stringify("PROJECTKEY"))},
  email: ${fieldTemplate(connection.email, "process.env.JIRA_EMAIL")},
  token: ${fieldTemplate(connection.token, "process.env.JIRA_API_TOKEN")},

  // Category folders to materialise as symlink folders:
  categoryFolders: [],

  // Index pages, per folder (omit for defaults everywhere):
  categoryIndex: {
    assignee: ["key", "summary"],
    labels: ["key", "summary"],
    parent: ["key", "summary"],
    status: ["key", "summary"],
  },
};
`;
}

/** Render one connection field, falling back to the template default. */
function fieldTemplate(
  value: FieldValue | undefined,
  fallback: string,
): string {
  if (value === undefined) return fallback;
  return value.kind === "literal"
    ? JSON.stringify(value.value)
    : `process.env.${value.name}`;
}

function display(path: string): string {
  try {
    const rel = relative(Deno.cwd(), path);
    return rel === "" ? path : rel;
  } catch {
    return path;
  }
}
