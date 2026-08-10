/**
 * Client-side badge copy. The server (server/src/badges.ts) owns eligibility and
 * persistence -- a stable `badgeId` and an `unlockedAt` timestamp, nothing else -- and
 * this is the only place a badge has a name or a description. That split means the copy
 * can change freely without touching what's actually stored.
 *
 * An unrecognized `badgeId` (older client, newer server, or vice versa) is simply not in
 * `BADGE_ORDER` and does not render -- PlayerHome.tsx iterates this list, not the badges
 * a player happens to hold, so a stale entry degrades to invisible rather than to a crash.
 */

export interface BadgeDefinition {
  readonly label: string;
  readonly description: string;
}

export const BADGE_DEFINITIONS: Readonly<Record<string, BadgeDefinition>> = {
  "first-steps": {
    label: "First Steps",
    description: "Inserted a disk and pressed a key. The rest is consequence.",
  },
  completionist: {
    label: "Completionist",
    description:
      "Found every ending one story had to give. Including the bad ones. Especially those.",
  },
  collector: {
    label: "Collector",
    description:
      "Unlocked achievements in three different stories. A diversified portfolio of poor decisions.",
  },
  marathoner: {
    label: "Marathoner",
    description:
      "Two hundred moves in a single sitting. The disk is warm. So are you.",
  },
  seasoned: {
    label: "Seasoned",
    description:
      "Reached an ending in five different stories. The system recognizes a regular.",
  },
  "witching-hour": {
    label: "Witching Hour",
    description:
      "Played at 3 AM. Server time, which is UTC, which is nobody's excuse.",
  },
  "ghosted-it": {
    label: "Ghosted It",
    description:
      "Started a run, never returned. Thirty days later the cursor is still blinking.",
  },
  "one-job": {
    label: "One Job",
    description:
      "Ten sessions. One story. The library has eight others. No pressure.",
  },
  "chaos-gremlin": {
    label: "Chaos Gremlin",
    description:
      "Submitted far more than the story asked for. The parser filed a complaint.",
  },
  "zen-master": {
    label: "Zen Master",
    description:
      "Walked a story to its ending with nothing wasted. Suspiciously deliberate.",
  },
  multiclass: {
    label: "Multiclass",
    description:
      "Played every engine kind on this system. Currently one kind. Enjoy the easy one.",
  },
  "slow-burn": {
    label: "The Slow Burn",
    description: "A run left open for ninety days. Not abandoned. Marinating.",
  },
  streak: {
    label: "Streak",
    description:
      "Seven consecutive days on the system. The night operator knows your handle.",
  },
  "century-club": {
    label: "Century Club",
    description:
      "One thousand moves logged across every story. The counter needed a fourth digit.",
  },
  "achievement-blackout": {
    label: "Achievement Blackout",
    description:
      "Finished three stories and unlocked nothing in any of them. Flawless efficiency.",
  },
  "sleep-schedule-nonexistent": {
    label: "Sleep Schedule: Nonexistent",
    description:
      "All twenty-four hours touched. The system is not qualified to advise you.",
  },
  "frequent-flyer": {
    label: "Frequent Flyer",
    description:
      "Folded your progress into this account twice. Baggage transferred intact.",
  },
  "math-is-hard": {
    label: "Math Is Hard",
    description:
      "Fewer attempts logged than moves taken. Someone's counter disagrees with reality.",
  },
};

/** Stable display order: earned-or-not, the grid always reads the same. */
export const BADGE_ORDER: readonly string[] = Object.keys(BADGE_DEFINITIONS);
