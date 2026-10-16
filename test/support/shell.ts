/**
 * The shell a scenario runs commands in: a directory of its own, and the CLI
 * built from this repo. Outside `test/steps/` on purpose, because the `steps`
 * glob in playwright.config.ts loads everything in there as a step file, and
 * only a step file registers steps.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const cli = join(process.cwd(), "src", "cli.ts");

export type Run = { code: number; stdout: string; stderr: string };

export class Shell {
  #dir = process.cwd();
  #lastRun: Run | null = null;

  /** Where commands run. The CLI reads and writes only here. */
  get dir(): string {
    return this.#dir;
  }

  /** What the last run left behind, which is what a `Then` step asserts on. */
  get lastRun(): Run {
    if (this.#lastRun === null) throw new Error("nothing has been run yet");
    return this.#lastRun;
  }

  /** Move into a directory of its own that holds nothing yet. */
  async enterEmptyDir(): Promise<void> {
    this.#dir = await mkdtemp(join(process.cwd(), ".tmp", "e2e-"));
    this.#lastRun = null;
  }

  /**
   * Runs `"jira-local init --yes"` as written in the feature. The feature text
   * is split here rather than in the step, so a quoted value stays one
   * argument, and only `jira-local` may be run at all.
   */
  run(command: string): Promise<Run> {
    const words = command.match(/"[^"]*"|\S+/g) ?? [];
    if (words[0] !== "jira-local") {
      throw new Error(`steps can only run jira-local, got "${words[0] ?? ""}"`);
    }
    const args = words.slice(1).map((word) =>
      word.startsWith('"') ? word.slice(1, -1) : word
    );

    const child = spawn(
      process.execPath,
      [
        "run",
        "--allow-net",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        cli,
        ...args,
      ],
      { cwd: this.#dir, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout += chunk);
    child.stderr.on("data", (chunk: string) => stderr += chunk);

    return new Promise((resolveRun) => {
      child.once("close", (code) => {
        this.#lastRun = { code: code ?? 1, stdout, stderr };
        resolveRun(this.#lastRun);
      });
    });
  }

  /**
   * The config is a TS module importing from `jsr:@jollytoad/jira-local`, so
   * reading it as text keeps the assertion against this repo rather than the
   * published package — and keeps the quoting meaningful, where `"a"` is a
   * literal the config owns and `process.env.X` is evaluated when it loads.
   */
  async readConfig(): Promise<Map<string, string>> {
    const path = join(this.#dir, ".jira", ".config.ts");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      throw new Error(`${path} was never written`);
    }
    const fields = new Map<string, string>();
    for (const line of text.split("\n")) {
      const [, name, value] = /^ {2}(\w+): (.+?),?$/.exec(line) ?? [];
      if (name !== undefined && value !== undefined) fields.set(name, value);
    }
    return fields;
  }
}
