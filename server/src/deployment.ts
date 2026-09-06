/**
 * What the *deployed* process wires up, separated from `index.ts` so it can be asserted in
 * a test without booting a server or holding a database.
 *
 * `index.ts` stays the only reader of `process.env` (issue #12): the values below arrive as
 * parameters, and nothing here consults the environment. What it owns instead is the pair of
 * content sources that are properties of the deployment rather than of the environment --
 * the hardcoded published source, and the snapshot the server falls back to when that source
 * cannot be built. Both used to live inline in `index.ts`, where "does the deployed server
 * actually pass a bootstrap source?" was a question only a human reading the file could
 * answer -- and for a while the answer was no while two comments elsewhere said yes
 * (issue #53).
 */
import type { Pool } from "pg";
import type { AppConfig } from "./app.js";
import { createMultiSourceCampaignSource } from "./campaigns/multi-source.js";
import { createDiskCampaignSource } from "./campaigns/source.js";
import type { CampaignSource } from "./campaigns/source.js";
import type { DiscussionForum } from "./discussions/forum.js";

/**
 * The one hardcoded, unremovable content source (issue #27) -- always prepended ahead of
 * whatever an admin has added through `/api/admin/content/sources` (content-sources.ts).
 * It is not admin-editable and carries no `CAMPAIGNS_DIR`/env override: the way to point a
 * deployment somewhere else is to add another source, not to change this one.
 *
 * `The-Running-Dev/SubZeroDev.Adventures.Content` serves its manifest at the repo root, not
 * under a `v2/` path -- an earlier commit here guessed `v2/` before the site had actually
 * finished publishing and got it wrong; verified live against the deployed Pages site before
 * fixing this.
 */
export function createPublishedCampaignSource(pool: Pool): CampaignSource {
  return createMultiSourceCampaignSource(pool, {
    id: "builtin-default",
    label: "SubZeroDev.Adventures.Content",
    kind: "url",
    url: "https://the-running-dev.github.io/SubZeroDev.Adventures.Content/",
  });
}

/**
 * The snapshot a deployment boots from when the *first* build off the published source
 * fails -- `content-cell.ts`'s `ready`, and `app.ts`'s `bootstrapSource`.
 *
 * It reads `public/campaigns/`, the committed fixture set, which `server/Dockerfile` copies
 * into the image and points `CAMPAIGNS_DIR` at. That is a deliberate change of posture:
 * before issue #53 the image carried no content at all, on the reasoning that the deployed
 * server has no disk content source and fixtures in a production image are a liability. The
 * counterweight is that a single unbuildable campaign -- one string-key collision in the
 * published content was enough -- aborted the boot, the process exited before binding a
 * port, and the admin API that could have removed the offending source was the thing that
 * never came up. A snapshot that is merely *stale* is recoverable from the running admin
 * page; a server that will not start is recoverable only through psql.
 *
 * Nothing hides that the snapshot is being served: `ContentStatus.bootstrapFallback` stays
 * true and `lastError` keeps the real reason until a refresh succeeds.
 */
export function createBootstrapCampaignSource(): CampaignSource {
  return createDiskCampaignSource();
}

/** The full `AppConfig` the deployed process hands `buildApp`. `env` is what `index.ts`
 *  read out of the environment; everything else is a property of the deployment. */
export function deploymentConfig(
  pool: Pool,
  env: {
    readonly siteUrl: string;
    readonly apiUrl: string;
    readonly previewOrigins: readonly string[];
    readonly discussionForum: DiscussionForum | undefined;
  },
): AppConfig {
  return {
    siteUrl: env.siteUrl,
    apiUrl: env.apiUrl,
    previewOrigins: env.previewOrigins,
    campaignSource: createPublishedCampaignSource(pool),
    bootstrapSource: createBootstrapCampaignSource(),
    discussionForum: env.discussionForum,
  };
}
