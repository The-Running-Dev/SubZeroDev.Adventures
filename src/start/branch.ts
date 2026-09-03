/**
 * The `/start` page's branch state machine: one fork, then a short walk inside whichever
 * branch was taken.
 *
 * Ported from the design bundle's `useBranch.ts`, which is shared verbatim by all five of
 * that turn's directions -- they differ only in the chrome around the fork, never in this.
 * Kept as its own module for the same reason it was one there: the page component should be
 * markup, and this is the only stateful thing on it.
 *
 * One difference from the mockup, deliberate. Its landing shows "3 of 9 steps · resumed from
 * Tuesday" -- persistent, cross-session onboarding progress. Nothing on this site records
 * that, so the bar here reports progress *within the chosen path*, which is real, rather
 * than a number that would have to be invented to be shown.
 */
import { useCallback, useMemo, useState } from "react";
import type { StartPath, WalkScreen } from "./content";

export interface BranchState {
  /** 0 is the fork itself; 1..`total` are steps inside the chosen path. */
  readonly step: number;
  readonly onLanding: boolean;
  readonly selected: StartPath | undefined;
  readonly screen: WalkScreen | undefined;
  readonly total: number;
  readonly percent: number;
  readonly isLast: boolean;
  readonly pick: (id: string) => void;
  readonly next: () => void;
  readonly back: () => void;
  readonly restart: () => void;
}

export function useBranch(paths: readonly StartPath[]): BranchState {
  const [step, setStep] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();

  const selected = paths.find((path) => path.id === selectedId);
  const total = selected?.walk.length ?? 0;

  const pick = useCallback((id: string) => {
    setSelectedId(id);
    setStep(1);
  }, []);
  const next = useCallback(
    () => setStep((current) => Math.min(total, current + 1)),
    [total],
  );
  const back = useCallback(
    () => setStep((current) => Math.max(0, current - 1)),
    [],
  );
  const restart = useCallback(() => {
    setStep(0);
    setSelectedId(undefined);
  }, []);

  return useMemo(
    () => ({
      step,
      onLanding: step === 0,
      selected,
      screen: step === 0 ? undefined : selected?.walk[step - 1],
      total,
      percent: total === 0 ? 0 : Math.round((step / total) * 100),
      isLast: total > 0 && step === total,
      pick,
      next,
      back,
      restart,
    }),
    [step, selected, total, pick, next, back, restart],
  );
}

/** Block-drawn progress bar, e.g. `█████░░░░░░░░░░` -- the installer chrome's own idiom,
 *  and readable in every palette because it is text, not a filled element. */
export function blockBar(step: number, total: number, cells = 15): string {
  const filled = total === 0 ? 0 : Math.round((step / total) * cells);
  return "█".repeat(filled) + "░".repeat(cells - filled);
}
