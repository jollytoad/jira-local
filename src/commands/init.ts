/**
 * The `init` command: create a default `.jira/.config.ts` next to the issues
 * folder, refusing to touch an existing one. Connection fields passed as
 * flags are written into the config; the rest are left as comments.
 */

import { Command, ValidationError } from "@cliffy/command";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { configPath, getConfig } from "../config.ts";

export interface InitOptions {
  site?: string;
  project?: string;
  email?: string;
  token?: string;
}

export function initCommand() {
  return new Command()
    .description(
      "Create a default .jira/.config.ts (sibling of the issues folder).\n" +
        "Refuses to overwrite an existing config.",
    )
    .option(
      "--out <dir:string>",
      "Output directory, relative to the project root.",
      { default: ".jira/issues/all" },
    )
    .option(
      "--site <url:string>",
      "Write this Jira Cloud base URL into the config.",
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
    .action((options) => {
      return runInit(options.out, {
        site: options.site,
        project: options.project,
        email: options.email,
        token: options.token,
      });
    });
}

export async function runInit(
  out: string,
  prefill: InitOptions,
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

  await writeFile(config, template(prefill));
  // Prove the written file loads and validates (category fields are valid).
  await getConfig(outDir);

  const prefilled = ["site", "project", "email", "token"].filter(
    (field) => prefill[field as keyof InitOptions]?.trim(),
  );
  const remaining = ["site", "project", "email", "token"].filter(
    (field) => !prefilled.includes(field),
  );
  console.log(
    `Created ${display(config)} — ${
      prefilled.length > 0 ? `prefilled ${prefilled.join("/")}; ` : ""
    }${
      remaining.length === 0
        ? "connection settings complete, run deno task pull."
        : `set ${
          remaining.join("/")
        } in the config (unprefilled email/token read JIRA_EMAIL/JIRA_API_TOKEN from the environment), then run deno task pull.`
    }`,
  );
}

function template(prefill: InitOptions): string {
  let types = import.meta.resolve("../src/types.ts");
  if (types.startsWith("file:")) types = "../src/types.ts";

  const site = prefill.site?.trim() || "https://your-site.atlassian.net";
  const project = prefill.project?.trim() || "PROJECTKEY";
  const email = prefill.email?.trim() || undefined;
  const token = prefill.token?.trim() || undefined;

  return `import type { JiraLocalConfig } from ${JSON.stringify(types)};

export const config: JiraLocalConfig = {
  site: ${JSON.stringify(site)},
  project: ${JSON.stringify(project)},
  email: ${email ? JSON.stringify(email) : "process.env.JIRA_EMAIL"},
  token: ${token ? JSON.stringify(token) : "process.env.JIRA_API_TOKEN"},

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

function display(path: string): string {
  try {
    const rel = relative(Deno.cwd(), path);
    return rel === "" ? path : rel;
  } catch {
    return path;
  }
}
