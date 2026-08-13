/**
 * Running an in-progress draft in the real engine, in the author's own tab.
 *
 * This is the same composition `createLocalBrowserDemo` (`src/play/composition.ts`) builds,
 * with two deliberate differences:
 *
 *  - **The registry comes from the draft, never from disk.** `public/campaigns/` is
 *    test-fixture content, not a runtime source (CLAUDE.md, "Campaign Content"), so this
 *    module never calls `createBrowserDemo` and never fetches a manifest. The one campaign
 *    registered here is the one the author is writing.
 *  - **`persistence` is omitted.** `createInMemorySessionStore` without it keeps saves in
 *    memory for the lifetime of the store. That is not a convenience: the browser
 *    composition's `localPersistence` writes into `subzerodev.play.save.v1.*`, keyed by
 *    campaign id, and a playtest that wrote there would leave a save the disk shelf offers to
 *    resume -- for a campaign that only exists in this author's draft.
 *
 * `BrowserClient` itself is reused unchanged (`src/play/browser-client.ts`): it is a thin
 * projection over `SessionStore`, and a draft's store satisfies that interface exactly as the
 * shipped one does. That is the property worth keeping -- the playtest is the real runtime,
 * not a preview of it, so a draft that plays here plays the same way once it is submitted.
 *
 * Everything imported here is already in the shipped browser bundle through
 * `composition.ts`, so `scripts/verify-build.mjs`'s browser-portability gate has nothing new
 * to catch (the engine's digest hashes through `@noble/hashes`, not `node:crypto`).
 */
import { useEffect, useRef, useState } from "react";
import {
  createEngine,
  createInMemorySessionStore,
} from "@the-running-dev/game-engine";
import { buildCatalog, KINDS } from "../../shared/campaign-registry";
import { BrowserClient, type PlayState } from "../play/browser-client";
import { draftDigest, toPortableCampaign, type CampaignDraft } from "./draft";

export interface DraftRuntime {
  readonly client: BrowserClient;
  readonly campaignId: string;
}

/**
 * Throws if the draft does not validate -- callers gate on `validateDraft` first, and a
 * second, quieter validity check here would be the duplicated validator this feature avoids.
 * `buildCatalog` is deliberately the throwing entry point for that reason.
 */
export function createDraftRuntime(draft: CampaignDraft): DraftRuntime {
  const portable = toPortableCampaign(draft);
  const { registry } = buildCatalog([portable]);
  return {
    client: new BrowserClient(
      createInMemorySessionStore({
        engine: createEngine({ kinds: KINDS, registry }),
        registry,
      }),
    ),
    campaignId: portable.campaign.id,
  };
}

export interface PlaytestSession {
  readonly state: PlayState | undefined;
  readonly busy: boolean;
  readonly error: string | undefined;
  /** True once an edit has invalidated the run that was on screen. */
  readonly stale: boolean;
  readonly start: () => Promise<void>;
  readonly choose: (actionId: string) => Promise<void>;
}

/**
 * Owned by the wizard, not by the playtest panel.
 *
 * The panel only exists while its own step is selected, so state held inside it would be
 * discarded the moment the author went back to edit a scene -- which is exactly the moment
 * this hook has something to say. Lifting it up is what makes "you edited the draft, so that
 * run is gone" a message the author can actually receive; held any lower it would be
 * unreachable code that looked correct.
 */
export function useDraftPlaytest(draft: CampaignDraft): PlaytestSession {
  const [state, setState] = useState<PlayState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const runtime = useRef<DraftRuntime>(undefined);
  const builtDigest = useRef<string>(undefined);

  const digest = draftDigest(draft);

  useEffect(() => {
    if (builtDigest.current === undefined || builtDigest.current === digest)
      return;
    // The content changed under a run in progress. The engine was built from the previous
    // content and its session is keyed to it, so continuing that run would be a playtest of
    // something the author no longer has. Drop it and say so.
    runtime.current = undefined;
    builtDigest.current = undefined;
    setState(undefined);
    setStale(true);
  }, [digest]);

  async function start(): Promise<void> {
    setBusy(true);
    setError(undefined);
    setStale(false);
    try {
      const built = createDraftRuntime(draft);
      runtime.current = built;
      builtDigest.current = digest;
      setState(await built.client.start(built.campaignId));
    } catch (cause) {
      runtime.current = undefined;
      builtDigest.current = undefined;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function choose(actionId: string): Promise<void> {
    const client = runtime.current?.client;
    if (!client || !state) return;
    setBusy(true);
    setError(undefined);
    try {
      const { state: next } = await client.submit(state, actionId);
      setState(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return { state, busy, error, stale, start, choose };
}
