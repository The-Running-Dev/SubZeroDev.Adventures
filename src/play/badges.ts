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

  // -- Codewars-inspired expansion (issue #19 follow-up) -------------------------------

  "brute-force": {
    label: "Brute Force",
    description: "Eventually the door became embarrassed and opened.",
  },
  "speedrun-technically": {
    label: "Speedrun, Technically",
    description: "Content is optional.",
  },
  "scenic-route": {
    label: "Scenic Route",
    description: "You paid for the whole graph.",
  },
  "groundhog-day": {
    label: "Groundhog Day",
    description: "There are other disks.",
  },
  specialist: {
    label: "Specialist",
    description: "The system has stopped recommending alternatives.",
  },
  generalist: {
    label: "Generalist",
    description:
      "Finished a story on every engine kind this system runs. The completion-oriented cousin of Multiclass.",
  },
  tourist: {
    label: "Tourist",
    description: "Thank you for visiting.",
  },
  "perfect-attendance": {
    label: "Perfect Attendance",
    description: "We checked. Unfortunately.",
  },
  "employee-of-the-month": {
    label: "Employee of the Month",
    description: "A record month, logged and filed without comment.",
  },
  "productive-sunday": {
    label: "Productive Sunday",
    description: "There were alternatives.",
  },
  "one-more-turn": {
    label: "One More Turn",
    description: "That was apparently insufficient closure.",
  },
  "immediate-regret": {
    label: "Immediate Regret",
    description: "No. Do it again.",
  },
  "muscle-memory": {
    label: "Muscle Memory",
    description: "The illusion of free will remains fully operational.",
  },
  "creature-of-habit": {
    label: "Creature of Habit",
    description: "The system has learned when to expect you.",
  },
  "against-medical-advice": {
    label: "Against Medical Advice",
    description: "This achievement is not medical advice either.",
  },
  "disk-jockey": {
    label: "Disk Jockey",
    description: "Commitment remains under investigation.",
  },
  "the-long-way-around": {
    label: "The Long Way Around",
    description: "Same door, different hallway. Twice.",
  },
  "sequence-breaker": {
    label: "Sequence Breaker",
    description: "The author had plans.",
  },
  "unreasonably-efficient": {
    label: "Unreasonably Efficient",
    description: "We built error handling for nothing.",
  },
  "persistence-is-a-character-flaw": {
    label: "Persistence Is A Character Flaw",
    description: "The disk surrendered.",
  },
  "top-1-percent": {
    label: "Top 1%",
    description:
      "You have made more rejected moves than 99% of operators. This is not the percentile you wanted.",
  },
};

/** Stable display order: earned-or-not, the grid always reads the same. */
export const BADGE_ORDER: readonly string[] = Object.keys(BADGE_DEFINITIONS);

export interface ProfileRank {
  readonly label: string;
  readonly description: string;
}

/**
 * The "badge of a badge" -- a single rank derived from how many badges a player holds,
 * rather than stored anywhere. Re-spaced against `BADGE_ORDER.length` (39, up from the
 * 18 this ladder was originally tuned for) rather than hardcoded boundaries, so it stays
 * proportional if the badge count changes again.
 */
const PROFILE_RANKS: readonly {
  readonly min: number;
  readonly rank: ProfileRank;
}[] = [
  {
    min: 0,
    rank: {
      label: "Untitled Guest",
      description: "Exists. That is currently the entire accomplishment.",
    },
  },
  {
    min: 2,
    rank: {
      label: "Technically Playing",
      description: "Proof of life, filed and time-stamped.",
    },
  },
  {
    min: 6,
    rank: {
      label: "Making a Habit of It",
      description: "Getting a feel for the shelf.",
    },
  },
  {
    min: 12,
    rank: {
      label: "Certified Adventurer",
      description: "A pattern is forming, and it looks like effort.",
    },
  },
  {
    min: 18,
    rank: {
      label: "Seasoned Operator",
      description:
        "Nobody asked for this level of commitment. Nobody's stopping it either.",
    },
  },
  {
    min: 24,
    rank: {
      label: "Overachiever",
      description: "The system did not expect anyone to get this far.",
    },
  },
  {
    min: 30,
    rank: {
      label: "Terminal Legend",
      description: "A few badges short of a real problem.",
    },
  },
  {
    min: BADGE_ORDER.length,
    rank: {
      label: "Ran Out Of Badges",
      description:
        "Achieved everything this system currently knows how to measure. Concerning.",
    },
  },
];

export function profileRankFor(badgeCount: number): ProfileRank {
  let current = PROFILE_RANKS[0]!.rank;
  for (const tier of PROFILE_RANKS) {
    if (badgeCount >= tier.min) current = tier.rank;
  }
  return current;
}
