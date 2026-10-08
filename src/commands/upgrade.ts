import { UpgradeCommand } from "@cliffy/command/upgrade";
import type {
  BinaryUpgradeContext,
  ProviderUpgradeOptions,
} from "@cliffy/upgrade";
import { UnsupportedUpgradeError } from "@cliffy/upgrade";
import {
  GithubProvider,
  type GithubVersions,
} from "@cliffy/upgrade/provider/github";

/** Cliffy normalises to `darwin`/`linux` and `aarch64`/`x86_64`; release
 * assets are named after the rust target triple. */
const TARGETS: Record<string, string> = {
  "darwin-aarch64": "aarch64-apple-darwin",
  "darwin-x86_64": "x86_64-apple-darwin",
  "linux-aarch64": "aarch64-unknown-linux-gnu",
  "linux-x86_64": "x86_64-unknown-linux-gnu",
};

// Releases are tagged v<version> but the cli reports the bare version, so the
// tag form is stripped everywhere and only put back for the github api.
class ReleaseProvider extends GithubProvider {
  override async getVersions(name: string): Promise<GithubVersions> {
    const { latest, versions, tags, branches } = await super.getVersions(name);
    return {
      latest: bare(latest),
      versions: versions.map(bare),
      tags: tags.map(bare),
      branches,
    };
  }

  override async resolveVersion(
    name: string,
    version: string,
  ): Promise<string> {
    return `v${await super.resolveVersion(name, version)}`;
  }

  override listVersions(name: string, currentVersion?: string): Promise<void> {
    return super.listVersions(name, currentVersion && `v${currentVersion}`);
  }

  // Reached only when this is not a compiled binary, where replacing the
  // running executable would clobber the runtime instead.
  override upgrade(_options: ProviderUpgradeOptions): Promise<void> {
    throw new UnsupportedUpgradeError(
      "jira-local upgrade replaces the running binary, so it only works for " +
        "the compiled one — upgrade a Deno install with:\n" +
        "  deno install --global --force jsr:@jollytoad/jira-local/cli",
    );
  }
}

function bare(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

export default new UpgradeCommand({
  // Cliffy's spinner has its own colour gate, ignoring NO_COLOR and style.ts.
  spinner: false,
  provider: new ReleaseProvider({
    repository: "jollytoad/jira-local",
    branches: false,
    asset: (context: BinaryUpgradeContext) => {
      const target = TARGETS[`${context.os}-${context.arch}`];
      if (!target) {
        throw new UnsupportedUpgradeError(
          `No jira-local release is published for ${context.os}-${context.arch}.`,
        );
      }
      return `${context.name}-${context.version}-${target}.tar.gz`;
    },
  }),
});
