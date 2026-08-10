/**
 * Client-owned copy for the standings page, the position-keyed analogue of `badges.ts`'s
 * `PROFILE_RANKS`/`profileRankFor`. `server/src/ranking.ts` ships positions and numbers
 * only -- this is the only place a position has a title or a description.
 */
import { BADGE_DEFINITIONS, CROWN_BADGE_ID } from "./badges";

export interface PositionTitle {
  readonly label: string;
  readonly description: string;
}

/** Position 1's title is derived from the crown badge's own label, not a second
 *  hardcoded string -- the post and the permanent badge for having once held it must
 *  always read as the same words (`src/play/ranking.test.ts` pins this). */
const INTERIM_HEAD_OF_ABSURDITY: PositionTitle = {
  label: BADGE_DEFINITIONS[CROWN_BADGE_ID]!.label,
  description:
    "Holds more disorder than anyone else who agreed to be measured. The post is interim. Everything here is interim.",
};

/** Ascending by position, each tier's `max` the last position it covers -- the mirror
 *  image of `PROFILE_RANKS`' `min`-bounded tiers, since standings count down from #1
 *  rather than up from zero badges. */
const POSITION_TITLES: readonly {
  readonly max: number;
  readonly title: PositionTitle;
}[] = [
  { max: 1, title: INTERIM_HEAD_OF_ABSURDITY },
  {
    max: 3,
    title: {
      label: "Deputy Nuisance",
      description:
        "Near enough the top to be a problem. Not near enough to be the problem.",
    },
  },
  {
    max: 10,
    title: {
      label: "Senior Complication",
      description: "Reliably in the way. The system has budgeted for it.",
    },
  },
  {
    max: 25,
    title: {
      label: "Person of Interest",
      description: "Flagged for review. This page is the review.",
    },
  },
  {
    max: 50,
    title: {
      label: "Registered Operator",
      description: "On the list. Not near the top of it.",
    },
  },
  {
    max: Number.POSITIVE_INFINITY,
    title: {
      label: "Filed Under Other",
      description: "Present in the record. That is the extent of the finding.",
    },
  },
];

/** Clamps anything at or below zero to band 1 -- a position never legitimately drops
 *  below 1, but this stays defensive rather than throwing on bad input. */
export function positionTitleFor(position: number): PositionTitle {
  const clamped = position < 1 ? 1 : position;
  for (const tier of POSITION_TITLES) {
    if (clamped <= tier.max) return tier.title;
  }
  return POSITION_TITLES[POSITION_TITLES.length - 1]!.title;
}
