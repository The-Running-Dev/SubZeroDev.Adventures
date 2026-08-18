/**
 * Assembles the configured `DiscussionForum` from the environment, mirroring
 * `identity/registry.ts`'s shape: unset credentials simply mean the feature is not
 * configured, and `routes/discussions.ts` answers `503 not_configured` rather than being
 * blocked from starting. This is the only file in the feature that reads `process.env` or
 * names a vendor -- both of which `identity/registry.ts` is also allowed to do, for the
 * same reason.
 *
 * Unlike `loadIdentityProviders`, this is synchronous: `createGitHubDiscussionForum` does
 * no I/O at construction (its repository/category ids are resolved lazily, on first use --
 * see `github.ts`), so there is nothing here to await.
 */
import { cachedDiscussionForum } from "./cache.js";
import { createGitHubDiscussionForum } from "./github.js";
import type { DiscussionForum } from "./forum.js";

function readEnv(name: string): string {
  // `||`, not `??` -- docker-compose.yml's `${VAR:-}` interpolation makes an unset
  // optional value an empty string inside the container, not literally absent
  // (`identity/registry.ts` documents the same trap for `OIDC_PROVIDER_NAME`).
  return (process.env[name] || "").trim();
}

const REPO_PATTERN = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

export function loadDiscussionForum(): DiscussionForum | undefined {
  const repo = readEnv("DISCUSSIONS_REPO");
  const token = readEnv("DISCUSSIONS_TOKEN");
  const category = readEnv("DISCUSSIONS_CATEGORY");

  // All-or-nothing, same predicate as the OIDC provider: deployment must never be blocked
  // on an optional integration existing yet.
  if (!repo || !token || !category) return undefined;

  const match = REPO_PATTERN.exec(repo);
  if (!match) {
    // A malformed value throws rather than quietly returning "not configured" -- an
    // operator who set all three variables and gets a UI saying the feature is off, with
    // nothing to grep for, is the worst outcome a typo can produce here.
    throw new Error(
      `DISCUSSIONS_REPO must be "owner/repo" (got ${JSON.stringify(repo)})`,
    );
  }
  const [, owner, name] = match;

  return cachedDiscussionForum(
    createGitHubDiscussionForum({
      owner: owner!,
      repo: name!,
      categorySlug: category,
      token,
    }),
  );
}
