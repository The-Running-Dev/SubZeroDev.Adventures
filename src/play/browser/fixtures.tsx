import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import PlayApp from "../PlayApp";
import { StartPage } from "../../start/StartPage";

/**
 * Shared real-UI state fixtures for W65's accessibility (W65.4) and visual
 * (W65.5) specs. Every fixture drives the actually-shipped `<PlayApp />`
 * through a real campaign; none of them render a stand-in.
 */

export interface Reached {
  readonly container: HTMLElement;
  readonly unmount: () => void;
  readonly user: ReturnType<typeof userEvent.setup>;
}

async function mountAndOpen(campaignPattern: RegExp): Promise<Reached> {
  /**
   * These fixtures test the arcade-cabinet composition specifically -- the
   * phone two-page model, hit-area floors, visual baselines -- none of
   * which exist under every theme (BBS Terminal strips that composition
   * out entirely). Pinning `dos` here decouples "what these regression
   * specs are about" from "whatever the app's default theme happens to be
   * today," so a future default change doesn't silently start testing the
   * wrong thing.
   */
  localStorage.setItem("subzerodev.play.theme.v1", "dos");
  const user = userEvent.setup();
  const { container, unmount } = render(<PlayApp />);
  await user.click(
    await screen.findByRole("button", { name: campaignPattern }),
  );
  await user.click(screen.getByRole("button", { name: "Load" }));
  await screen.findByRole("heading", { level: 1 });
  return { container, unmount, user };
}

export async function reachPlaying(): Promise<Reached> {
  return mountAndOpen(/The Bureaucracy/i);
}

export async function reachEnded(): Promise<Reached> {
  const reached = await mountAndOpen(/The Bureaucracy/i);
  for (let step = 0; step < 10; step += 1) {
    if (screen.queryByText("SESSION COMPLETE")) break;
    const deck = reached.container.querySelector(".action-deck");
    const next = deck?.querySelector<HTMLButtonElement>(
      "button:not(:disabled)",
    );
    if (!next) break;
    await reached.user.click(next);
  }
  await screen.findByText("SESSION COMPLETE");
  return reached;
}

export async function reachRejected(): Promise<Reached> {
  const reached = await mountAndOpen(/The Bureaucracy/i);
  const waitButton = await screen.findByRole("button", {
    name: /Wait for the municipal registry/i,
  });
  // Native dispatch, not Testing Library's fireEvent/userEvent: both of
  // those wrap the event in `act()`, which flushes the disabling state
  // update between calls. Two raw synchronous dispatches submit the same
  // action id twice against one session before either resolves, so the
  // second is rejected by the engine once the first has already advanced it.
  waitButton.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  waitButton.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  await screen.findByText(
    "That action was rejected. The scene has not changed.",
  );
  return reached;
}

/**
 * `PlayApp` never passes a seed to `createSession` (a real player does not
 * choose one), so this route forks on genuine engine randomness at
 * `company_route_event_1a/1b`. The scripted labels reach the one gated
 * ending in this content when a run lands on the "1a" fork; a run that
 * diverges onto "1b" is played to completion and then retried from a fresh
 * session, rather than produce a flaky failure. The retry budget is
 * generous enough that exhausting it means the gate is genuinely gone from
 * the content, not that every attempt was unlucky.
 */
export async function reachUnavailableChoice(
  maxAttempts = 60,
): Promise<Reached> {
  const scriptedRoute = [
    "Build a company before the inspectors return",
    "Explain the runway and hire carefully",
    "Save the outage postmortem",
    "Submit the boldest possible bid",
    "Promote the teammate who held the outage",
    "Call in the favour you earned",
  ];

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const reached = await mountAndOpen(/Enterprise/i);

    for (const label of scriptedRoute) {
      const next = screen.queryByRole("button", { name: label });
      if (next) {
        await reached.user.click(next);
        continue;
      }
      // Diverged onto the sibling random branch: play any single forced
      // action forward until the run ends, then retry from scratch.
      for (let step = 0; step < 10; step += 1) {
        if (screen.queryByText("SESSION COMPLETE")) break;
        const deck = reached.container.querySelector(".action-deck");
        const forced = deck?.querySelector<HTMLButtonElement>(
          "button:not(:disabled)",
        );
        if (!forced) break;
        await reached.user.click(forced);
      }
      break;
    }

    const unavailable = screen.queryByRole("button", {
      name: "The Platform Bet",
    });
    if (unavailable) return reached;
    reached.unmount();
  }

  throw new Error(
    `expected the Enterprise "company" route to reach a gated ending within ${maxAttempts} attempts`,
  );
}

/**
 * `composition.ts` probes `localStorage` with one throwaway key before
 * trusting it, then writes saves under a separate `subzerodev.play.save.v1.*`
 * key. Failing only the second key reproduces a real write failure (e.g. a
 * full quota) without touching `PlayApp`/`composition.ts` themselves.
 */
export async function reachPersistenceWarning(): Promise<
  Reached & { restore: () => void }
> {
  const original = Storage.prototype.setItem;
  const spy = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith("subzerodev.play.save.v1.")) {
        throw new DOMException("Simulated quota failure", "QuotaExceededError");
      }
      return original.call(this, key, value);
    });

  const reached = await mountAndOpen(/The Bureaucracy/i);
  await screen.findByText(
    "Progress could not be saved locally; this run remains available in this tab.",
  );
  return { ...reached, restore: () => spy.mockRestore() };
}

/**
 * `/start` and the authoring wizard (`src/start/`).
 *
 * Rendered here, alongside `PlayApp`'s fixtures, rather than in a spec file of their own:
 * `vitest.browser.config.ts`'s Windows exclusion and
 * `.github/workflows/update-visual-baselines.yml`'s upload and `git add` paths are both
 * written against one screenshot directory, and that directory is derived from the *spec
 * file's* name. A second spec would mean maintaining that path in three more places for no
 * gain -- so these render into the same baseline set the shipped `/play/` states do.
 *
 * The theme is pinned for the same reason `mountAndOpen` pins it: what the baseline is about
 * should not change because the app's default display mode did.
 */
export function reachStartLanding(): Reached {
  localStorage.setItem("subzerodev.play.theme.v1", "dos");
  const user = userEvent.setup();
  const { container, unmount } = render(<StartPage />);
  return { container, unmount, user };
}

/** The wizard on its scenes step, holding a complete draft -- the densest thing it renders,
 *  and the one whose layout a CSS change is most likely to break. */
export async function reachAuthoringWizard(): Promise<Reached> {
  localStorage.setItem("subzerodev.play.theme.v1", "dos");
  localStorage.setItem(
    "subzerodev.play.draft.v1",
    JSON.stringify(baselineDraft),
  );
  const user = userEvent.setup();
  const { container, unmount } = render(<StartPage />);
  await user.click(
    await screen.findByRole("button", { name: /Write a campaign/i }),
  );
  await user.click(await screen.findByRole("button", { name: /^3\) Scenes$/ }));
  return { container, unmount, user };
}

/** Fixed content, so the capture is a function of the CSS and nothing else. */
const baselineDraft = {
  id: "harbour-night",
  title: "Harbour Night",
  description: "A short walk by the water.",
  duration: "~3 min",
  contentNotice: "",
  version: "1.0.0",
  startNodeId: "start",
  variables: [
    {
      name: "nerve",
      type: "int",
      initial: "2",
      values: "",
      min: "0",
      max: "5",
      visible: true,
      label: "Nerve",
    },
  ],
  nodes: [
    {
      id: "start",
      kind: "choice",
      text: "The dock lights buzz. Nerve: {nerve}",
      choices: [
        {
          id: "walk",
          label: "Walk to the end of the pier.",
          goto: "pier",
          effects: [{ variable: "nerve", op: "increment", value: "1" }],
        },
      ],
      endingId: "",
      outcome: "neutral",
    },
    {
      id: "pier",
      kind: "ending",
      text: "You reach the end. The water is very black.",
      choices: [],
      endingId: "pier_end",
      outcome: "win",
    },
  ],
  achievements: [],
};
