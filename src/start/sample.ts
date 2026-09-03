/**
 * A ready-made campaign for the wizard's "start from a sample" door.
 *
 * Hand-written here, inside the subset `draft.ts` actually authors (choice and ending nodes,
 * one typed visible variable, choice effects, an ending-triggered reward). It is deliberately
 * *not* a transcription of `public/campaigns/getting-started.json` or of anything else under
 * `public/campaigns/`: that content is a fixture snapshot `npm run sync:campaigns` is free to
 * overwrite (CLAUDE.md, "Campaign Content"), and `getting-started` uses an `auto` node, which
 * is outside the wizard's scope line by design (`draft.ts`'s header). A sample the wizard
 * cannot edit would be a worse first thing to hand an author than no sample at all.
 *
 * `id` and `title` are empty on purpose, and no step is gated on that. `keyFor` prefixes every
 * string this campaign contributes with the campaign's own id, so naming it here would either
 * namespace an author's text under a name they did not pick, or -- if they never rename it --
 * hand every user of the sample the same id to collide on. The existing validation console
 * already says the campaign is unnamed, and submit is already blocked until it is; that is the
 * gate, and this file adds no second one.
 */
import { emptyDraft, type CampaignDraft } from "./draft";

/** Fresh on every call, like `emptyDraft` -- the returned value is handed straight to the
 *  wizard's state and edited from there, so a shared frozen constant would be a trap. */
export function sampleDraft(): CampaignDraft {
  return {
    ...emptyDraft(),
    id: "",
    title: "",
    description:
      "The last tram is gone and it is −6 °C. Three scenes, one stat, and two ways the walk home can end.",
    duration: "~3 min",
    contentNotice: "",
    version: "1.0.0",
    startNodeId: "platform",
    variables: [
      {
        name: "warmth",
        type: "int",
        initial: "4",
        values: "",
        min: "0",
        max: "10",
        visible: true,
        label: "Warmth",
      },
    ],
    nodes: [
      {
        id: "platform",
        kind: "choice",
        text: "The last tram left nine minutes ago. The shelter's heater is off, it is −6 °C, and the flat is two kilometres north.\n\nWarmth: {warmth}",
        choices: [
          {
            id: "wait",
            label: "Sit in the shelter and wait for the night bus.",
            goto: "shelter",
            effects: [{ variable: "warmth", op: "decrement", value: "1" }],
          },
          {
            id: "walk",
            label: "Start walking.",
            goto: "bridge",
            effects: [{ variable: "warmth", op: "increment", value: "1" }],
          },
        ],
        endingId: "",
        outcome: "neutral",
      },
      {
        id: "shelter",
        kind: "choice",
        text: "The bench is metal and the timetable behind the glass stops at 23:40. Somewhere down the line a gritter is working.\n\nWarmth: {warmth}",
        choices: [
          {
            id: "give_up",
            label: "Stay put. Something will come.",
            goto: "ending_cold",
            effects: [{ variable: "warmth", op: "decrement", value: "2" }],
          },
          {
            id: "reconsider",
            label: "Get up and walk after all.",
            goto: "bridge",
            effects: [{ variable: "warmth", op: "increment", value: "1" }],
          },
        ],
        endingId: "",
        outcome: "neutral",
      },
      {
        id: "bridge",
        kind: "choice",
        text: "The river is black under the bridge and the wind comes straight along it. The far bank is lit; your street is behind it.\n\nWarmth: {warmth}",
        choices: [
          {
            id: "cross",
            label: "Put your head down and cross.",
            goto: "ending_home",
            effects: [{ variable: "warmth", op: "increment", value: "2" }],
          },
          {
            id: "turn_back",
            label: "Turn back towards the shelter.",
            goto: "shelter",
            effects: [{ variable: "warmth", op: "decrement", value: "1" }],
          },
        ],
        endingId: "",
        outcome: "neutral",
      },
      {
        id: "ending_home",
        kind: "ending",
        text: "The stairwell is warmer than the street by about fifteen degrees, and you stand in it for a while before going up.",
        choices: [],
        endingId: "walked_home",
        outcome: "win",
      },
      {
        id: "ending_cold",
        kind: "ending",
        text: "The night bus arrives at 01:20. You are still on the bench, and you have been colder than this exactly once before.",
        choices: [],
        endingId: "waited_it_out",
        outcome: "loss",
      },
    ],
    achievements: [
      {
        id: "first_thaw",
        name: "Walked It Off",
        description: "Reached the flat on foot instead of waiting for a bus.",
        hidden: false,
        endingId: "walked_home",
      },
    ],
  };
}
