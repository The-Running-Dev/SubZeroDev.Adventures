/**
 * `/start`'s copy.
 *
 * The design bundle shipped placeholder text ("Northwind", "connect a warehouse"); this is
 * the real thing, and every claim in it is checkable against this repository -- the engine
 * arriving as a pinned submodule, the deployed server's single content source, campaigns
 * travelling as one portable JSON document, submissions being private until an admin
 * approves them. Kept as data rather than JSX so the page component stays layout.
 */

export type CheckState = "done" | "todo" | "locked";

export interface Check {
  readonly state: CheckState;
  readonly label: string;
}

export interface WalkScreen {
  readonly title: string;
  readonly body: string;
  readonly checks: readonly Check[];
}

export interface StartPath {
  /** The menu key the installer chrome shows -- `A)`, `B)`, ... */
  readonly key: string;
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly time: string;
  /** A path with no walk is a door: picking it leaves the page's own branch machine. */
  readonly walk: readonly WalkScreen[];
  /** Set on a path that leaves the site's own page entirely -- rendered as a link rather
   *  than a menu button, since it navigates rather than advancing the branch machine. */
  readonly href?: string;
}

const done = (label: string): Check => ({ state: "done", label });
const todo = (label: string): Check => ({ state: "todo", label });
const locked = (label: string): Check => ({ state: "locked", label });

export const CHECK_MARK: Readonly<Record<CheckState, string>> = {
  done: "[×]",
  todo: "[ ]",
  locked: "[–]",
};

/** The id of the path that opens the authoring wizard instead of walking a branch. */
export const AUTHOR_PATH_ID = "author";

/**
 * The guided intro's permanent link.
 *
 * `getting-started` is a hidden campaign (`src/play/composition.ts`), and `?campaign=<id>` is
 * a hidden campaign's only door in -- `PlayApp` auto-starts whatever that parameter names,
 * listed or not. So this needs no catalog entry, no change to the deployed content source,
 * and no unhiding: the campaign stays off the shelf and this link opens it anyway. Verified
 * present in the deployed source's manifest (`SubZeroDev.Adventures.Content`), not only in
 * this repository's `public/campaigns/` fixtures.
 */
export const GUIDED_INTRO_HREF = "/?campaign=getting-started";

export const PATHS: readonly StartPath[] = [
  {
    key: "A",
    id: "play",
    title: "Play a campaign",
    meta: "nothing to install",
    time: "~5 min",
    walk: [
      {
        title: "Pick a disk",
        body: "Every campaign on the shelf runs in this tab. Runs are deterministic: the same choices always replay to the same scene, which is what makes two people comparing the same route a meaningful thing to do.",
        checks: [
          done("Open the disk library"),
          todo("Load a campaign"),
          locked("Reach an ending"),
        ],
      },
      {
        title: "Read, then choose",
        body: "A scene arrives as text with numbered choices. Click one, or type its number. Nothing is timed, nothing is hidden behind an account, and a choice you cannot take tells you why instead of disappearing.",
        checks: [
          done("Load a campaign"),
          todo("Make a first choice"),
          locked("Reach an ending"),
        ],
      },
      {
        title: "Keep the run",
        body: "Sign in and your saves, badges and standings follow you between devices. Until you do, a run is kept in this browser alone — real, resumable, and gone if you clear site data.",
        checks: [
          done("Make a first choice"),
          todo("Sign in to keep it"),
          todo("Enter the standings"),
        ],
      },
    ],
  },
  {
    key: "B",
    id: "intro",
    title: "Play the guided intro",
    meta: "opens in the real player, not a demo of one",
    time: "~4 min",
    walk: [],
    href: GUIDED_INTRO_HREF,
  },
  {
    key: "C",
    id: AUTHOR_PATH_ID,
    title: "Write a campaign",
    meta: "assembles and playtests here in the browser",
    time: "~20 min",
    walk: [],
  },
  {
    key: "D",
    id: "embed",
    title: "Embed the engine in your own app",
    meta: "node 20+",
    time: "~20 min",
    walk: [
      {
        title: "Take the package",
        body: "The engine is an npm package with no runtime dependency on this site. It is deterministic by construction — no wall clock, no unseeded randomness — which is the property everything else here is built on.",
        checks: [
          done("Read what the engine is"),
          todo("Install the package"),
          locked("Register content"),
        ],
      },
      {
        title: "Register content",
        body: "A campaign travels as one portable JSON document: catalog card, content graph and string table together. Hydrate it, validate it into a frozen registry, and the registry is what the engine runs against.",
        checks: [
          done("Install the package"),
          todo("Hydrate and validate a campaign"),
          locked("Drive a session"),
        ],
      },
      {
        title: "Drive a session",
        body: "Create a session, read the scene, submit an action id, read the next scene. That loop is the whole client contract — this site is one implementation of it, and yours is a peer, not a special case.",
        checks: [
          done("Hydrate and validate a campaign"),
          todo("Drive a session"),
          todo("Replay the same inputs and compare"),
        ],
      },
    ],
  },
  {
    key: "E",
    id: "host",
    title: "Host your own instance",
    meta: "docker · postgres 15+",
    time: "~25 min",
    walk: [
      {
        title: "Clone with submodules",
        body: "The engine is a pinned git submodule, not a published version range, so a checkout without it has nothing to build against. One setup step builds it; bumping the pin is a real dependency upgrade, not a formality.",
        checks: [
          done("Clone the repository"),
          todo("Build the engine submodule"),
          locked("Bring up the stack"),
        ],
      },
      {
        title: "Bring up the stack",
        body: "The dev stack builds the API from source against a local Postgres. Migrations run as their own command rather than on boot, so a deploy that should not have migrated cannot do it by accident.",
        checks: [
          done("Build the engine submodule"),
          todo("Run the migrations"),
          todo("Start the API"),
        ],
      },
      {
        title: "Point it at content",
        body: "A deployed server has no campaigns on disk — it reads them from a content source you configure, and verifies each fetched campaign against its manifest digest before trusting it. Admins add sources; players submit their own.",
        checks: [
          done("Start the API"),
          todo("Configure a content source"),
          todo("Grant the first admin"),
        ],
      },
    ],
  },
];

export const BOOT_LINES: readonly {
  readonly label: string;
  readonly value: string;
}[] = [
  { label: "engine", value: "deterministic runtime, in this tab" },
  { label: "campaigns", value: "portable JSON, digest-verified" },
  { label: "account", value: "optional — needed only to keep a run" },
];
