import { SceneRegion } from "../features/play/SceneRegion";
import { ArrivalReceipt } from "../features/play/ArrivalReceipt";
import { ActionDeck } from "../features/play/ActionDeck";
import {
  StatusConsole,
  type JourneyEntry,
} from "../features/play/StatusConsole";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ResourceState } from "../components/ResourceState";
import { ApiError } from "../api/client";
import { Link } from "react-router";
import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { useTheme } from "../app/providers/ThemeProvider";
import { useAccount } from "../app/providers/AccountProvider";
import { usePlayerShell } from "../app/playerShell";
import { AdminPanel } from "./AdminPanel";
import { BbsPrompt } from "./BbsPrompt";
import { BrowserClient, type PlayState } from "./browser-client";
import {
  createBrowserDemo,
  GETTING_STARTED_CAMPAIGN_ID,
  hasSeenOnboarding,
  markOnboardingSeen,
  type BrowserCampaign,
  type BrowserDemo,
} from "./composition";
import {
  usePlatformStats,
  useProgress,
  type CampaignProgress,
} from "./identity";
import { PlatformStats } from "./PlatformStats";

/**
 * Every registered campaign has an entry, hidden ones included -- a direct
 * `?campaign=` link is a hidden campaign's only door in, and a campaign with no
 * entry here falls back to "STORY IN PROGRESS" and the house accent (the cabinet
 * marquee, once loaded) rather than a neutral default.
 *
 * Accents are skins, not ids, so sharing one is fine: the two Lucifer
 * prediction campaigns share `cobalt` because they are one family, and Saki
 * reuses `violet` simply because there is no seventh accent. The eyebrow is
 * what actually distinguishes them.
 */
const cabinetThemes: Readonly<
  Record<string, { accent: string; eyebrow: string }>
> = {
  "what-would-lucifer-do": { accent: "cobalt", eyebrow: "PREDICTION LOG" },
  "what-would-lucifer-do-engineers-cut": {
    accent: "cobalt",
    eyebrow: "PREDICTION LOG // ENGINEER'S CUT",
  },
  "lucifer-chronicles": { accent: "ember", eyebrow: "CELESTIAL CASE FILE" },
  "bulgaria-bureaucracy": { accent: "red", eyebrow: "MUNICIPAL ARCHIVE" },
  "bulgaria-return": { accent: "teal", eyebrow: "RETURN DEPARTMENT" },
  "bulgaria-driving": { accent: "yellow", eyebrow: "ROAD SAFETY OFFICE" },
  "bulgaria-inheritance": { accent: "green", eyebrow: "ESTATE RECORDS" },
  "bulgaria-enterprise": { accent: "violet", eyebrow: "ENTERPRISE DESK" },
  "saki-quest-for-redemption": {
    accent: "violet",
    eyebrow: "REDEMPTION FILE",
  },
  [GETTING_STARTED_CAMPAIGN_ID]: { accent: "green", eyebrow: "SYSTEM FILE" },
};

/** A permanent, shareable link that loads a campaign directly -- no click-through required. */
function permalinkFor(campaignId: string): string {
  return `${window.location.origin}/play/${encodeURIComponent(campaignId)}`;
}

function excerpt(text: string): string {
  return text.length <= 150 ? text : `${text.slice(0, 147).trimEnd()}…`;
}

/** "1" for a single option, "1-N" otherwise -- used in both the BBS prompt's hint line and its range errors. */
function rangeLabel(count: number): string {
  return count <= 1 ? "1" : `1-${count}`;
}

/** The dossier tile's one-line progress hint. Endings take priority when the campaign
 *  declares any (a spoiler-safe count, never which ones remain); otherwise falls back to
 *  a plain in-progress/finished status. */
function progressLabel(
  campaign: BrowserCampaign,
  entry: CampaignProgress,
): string {
  if (campaign.endingCount > 0) {
    return `${entry.endings.discovered.length}/${campaign.endingCount} endings found`;
  }
  return entry.status === "ended"
    ? "Finished"
    : `In progress · ${entry.stepCount} steps`;
}

/** A retro 8.3-style DOS name for the prompt sigil -- e.g. "The Bureaucracy" -> "BUREAUCR". */
function dosName(title: string): string {
  const cleaned = title
    .toUpperCase()
    .replace(/^(THE|A|AN)\s+/, "")
    .replace(/[^A-Z0-9]/g, "");
  return cleaned.slice(0, 8) || "STORY";
}

/** The same 768px boundary the stylesheet's phone rules use. */
const PHONE_QUERY = "(max-width: 767px)";

/**
 * Whether the viewport is phone-sized -- the one thing here that genuinely
 * cannot be expressed in CSS, since it decides whether the BBS command prompt
 * is in the DOM at all rather than merely how it looks.
 *
 * `useSyncExternalStore`, not `useState` + an effect, because its snapshot is
 * re-read on every render: a missed `change` event then costs at most a stale
 * frame, instead of pinning the wrong answer until the next resize. That is not
 * hypothetical -- viewport changes driven through CDP (how the browser specs
 * resize) do not always emit one, which left the prompt missing on desktop.
 */
function useIsPhone(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const query = window.matchMedia(PHONE_QUERY);
      query.addEventListener("change", onStoreChange);
      window.addEventListener("resize", onStoreChange);
      return () => {
        query.removeEventListener("change", onStoreChange);
        window.removeEventListener("resize", onStoreChange);
      };
    },
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}

// SPIKE: campaigns are runtime-loaded JSON, so building the browser demo is now async
// (a fetch, not a synchronous compiled-in build). This gate loads it once and hands the
// resolved `BrowserDemo` down as a prop, so `PlayAppReady` below is unchanged from the
// synchronous version other than reading `demo` from props. See plans/spike-notes.md.
interface PlayerRouteProps {
  initialCampaignId?: string;
  active?: boolean;
  onClose?: () => void;
  onNavigateLibrary?: () => void;
}
export default function PlayApp(props: PlayerRouteProps = {}) {
  const { t } = useTranslation("play");
  const { apiUrl: configuredApiUrl } = useAccount();
  const [demo, setDemo] = useState<BrowserDemo>();
  const [loadError, setLoadError] = useState<string>();
  // Bumped by the admin page's "Sync" to re-run the loader below. `demo` is deliberately
  // *not* cleared while a re-sync is in flight -- clearing it would drop the caller back
  // to the "Loading catalog…" gate and unmount the page that asked for the sync.
  const [syncToken, setSyncToken] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string>();
  const [syncedAt, setSyncedAt] = useState<string>();
  // Read inside the syncToken effect below without making `demo` itself a dependency --
  // `apiUrl` is fixed for the life of the session (createBrowserDemo picks local vs.
  // remote once, at startup), so this only exists to dodge the effect-retriggers-itself
  // loop that adding `demo` as a dependency would cause (it's set by this same effect).
  const demoRef = useRef<BrowserDemo | undefined>(undefined);
  demoRef.current = demo;

  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      if (syncToken > 0) {
        setSyncing(true);
        setSyncError(undefined);
      }

      // In remote mode, a re-sync asks the server to rebuild its own catalog first
      // (issue #27) -- otherwise "Sync" would only ever refetch whatever the server was
      // already serving. A rejected or failed refresh (not an admin, network error) does
      // not abort the sync: the local refetch below still runs, so the affordance never
      // regresses to doing nothing just because this session can't trigger a server-side
      // rebuild. Its message rides along as `syncError` instead.
      let refreshError: string | undefined;
      const apiUrl = demoRef.current?.apiUrl;
      if (syncToken > 0 && apiUrl) {
        try {
          const response = await fetch(`${apiUrl}/api/admin/content/refresh`, {
            method: "POST",
            credentials: "include",
          });
          if (!response.ok) {
            const body = (await response.json().catch(() => undefined)) as
              { error?: { code?: string } } | undefined;
            refreshError = `server refresh failed: ${response.status}${
              body?.error?.code ? ` (${body.error.code})` : ""
            }`;
          }
        } catch (error) {
          refreshError = error instanceof Error ? error.message : String(error);
        }
      }

      try {
        const loaded = await createBrowserDemo(configuredApiUrl);
        if (cancelled) return;
        setDemo(loaded);
        setSyncedAt(new Date().toLocaleTimeString());
        setSyncing(false);
        if (syncToken > 0) setSyncError(refreshError);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setSyncing(false);
        // A failed *re-sync* keeps the catalog already on screen and reports itself on
        // the admin page; only a failed first load has nothing to fall back to.
        if (demoRef.current) setSyncError(refreshError ?? message);
        else setLoadError(message);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [syncToken, configuredApiUrl]);

  if (loadError)
    return (
      <section className="play-load-error" role="alert">
        <h1>{t("catalogError")}</h1>
        <button
          className="app-button"
          onClick={() => {
            setLoadError(undefined);
            setSyncToken((token) => token + 1);
          }}
        >
          {t("retry")}
        </button>
      </section>
    );
  if (!demo) return <ResourceState state="loading" />;
  return (
    <PlayAppReady
      {...props}
      demo={demo}
      syncing={syncing}
      syncError={syncError}
      lastSyncedAt={syncedAt ?? "—"}
      onSync={() => setSyncToken((token) => token + 1)}
    />
  );
}

function PlayAppReady({
  initialCampaignId,
  active = true,
  onClose,
  onNavigateLibrary,
  demo,
  syncing,
  syncError,
  lastSyncedAt,
  onSync,
}: {
  readonly demo: BrowserDemo;
  readonly syncing: boolean;
  readonly syncError: string | undefined;
  readonly lastSyncedAt: string;
  readonly onSync: () => void;
} & PlayerRouteProps) {
  const { t } = useTranslation("play");
  const queries = useQueryClient();
  const refreshRecords = () => {
    if (demo.apiUrl)
      void queries.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "private" &&
          query.queryKey[1] === demo.apiUrl &&
          ["progress", "saves", "badges"].includes(String(query.queryKey[4])),
      });
  };
  const client = useMemo(() => new BrowserClient(demo.store), [demo.store]);
  const [state, setState] = useState<PlayState>();
  const [campaignId, setCampaignId] = useState<string>();
  const [selectedId, setSelectedId] = useState(demo.catalog[0]?.campaignId);
  const [message, setMessage] = useState<string>();
  const [saveFailed, setSaveFailed] = useState(false);
  const [arrivalChoice, setArrivalChoice] = useState<string>();
  const [journey, setJourney] = useState<readonly JourneyEntry[]>([]);
  const [busy, setBusy] = useState(false);
  /** Bumped on every game load and every return to the shelf, so the BBS prompt can clear its stale response/input independently of ordinary in-game state changes (choosing an action, selecting a disk). */
  const [bbsResetToken, setBbsResetToken] = useState(0);
  const { theme: displayTheme } = useTheme();
  const navigate = useNavigate();
  const { search } = useLocation();

  const { identity, isAdmin, adminAccessLoading, refreshIdentity } =
    useAccount();
  const progress = useProgress(demo.apiUrl, identity.playerId);
  const platformStats = usePlatformStats(demo.apiUrl);
  /** The profile page needs a signed-in (or guest) player to have anything to show, and a
   *  backend to fetch it from -- local mode has neither. */
  const profileAvailable =
    Boolean(demo.apiUrl) && identity.kind !== "anonymous";
  const sceneRegion = useRef<HTMLElement>(null);
  const isPhone = useIsPhone();
  /**
   * BBS Terminal is keyboard-first, which is a desktop premise: on a phone the
   * fixed prompt costs a third of the screen to summon an on-screen keyboard,
   * and every command it accepts is already a tappable button using the same
   * numbering it prints. So the prompt is desktop-only, and the theme falls
   * back to the buttons it has always rendered.
   */
  const showBbsPrompt = displayTheme === "bbs" && !isPhone;
  /** Invalidates in-flight submissions when the player leaves or restarts a run. */
  const runToken = useRef(0);
  /** A `?campaign=` link auto-starts once, on the initial mount -- not on every re-render. */
  const autoStarted = useRef(false);

  const selected = demo.findCampaign((state ? campaignId : selectedId) ?? "");
  const cabinetTheme = cabinetThemes[selected?.campaignId ?? ""];
  /** The landing wizard, full-screen and chromeless, rather than an ordinary story run. */
  const isOnboarding = campaignId === GETTING_STARTED_CAMPAIGN_ID;
  const ended = state?.scene.status === "ended";
  const sceneText = state?.scene.body.text;

  /**
   * BBS Terminal's whole point is playing without the mouse -- the command
   * prompt keeps focus for itself there instead (BbsPrompt.tsx), so the
   * usual scene-focus handoff would just fight it on every turn. Keyed on the
   * prompt actually being rendered, not on the theme: with no prompt on a
   * phone, nothing is competing and the scene should take focus as it does
   * everywhere else.
   *
   * `preventScroll: true` because this is an accessibility handoff, not a
   * navigation -- the phone reading model (14 §8.2) already puts the scene
   * and its choices in the first viewport with nothing to scroll past, and
   * the browser's default scroll-into-view on focus was nudging the page a
   * few pixels regardless, which is a scroll this handoff never intended.
   */
  useEffect(() => {
    if (active && sceneText && !showBbsPrompt)
      sceneRegion.current?.focus({ preventScroll: true });
  }, [active, sceneText, showBbsPrompt]);

  /**
   * Starting or resuming a run replaces the whole shelf with the cabinet, but leaves
   * whatever scroll position clicking "Load"/"Resume" (now inside a folded-open dossier
   * tile, possibly off the first screen) left behind -- the phone reading model's
   * promise that the scene and its choices need no scroll (14 §8.2) only holds if the
   * cabinet actually opens at the top. `behavior: "instant"`, not `"auto"` -- `"auto"`
   * defers to `html`'s `scroll-behavior: smooth` (index.css), animating the jump instead
   * of cutting to it, which is the page's default scroll and not this state transition.
   * Keyed on `campaignId`, which is set once per run, not once per turn.
   */
  useEffect(() => {
    if (active && campaignId)
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [active, campaignId]);

  /**
   * A permanent `?campaign=` link loads the adventure directly -- no dossier click, no
   * briefing step. A hidden campaign has no dossier tile at all, so this is its only door in.
   */
  useEffect(() => {
    if (autoStarted.current) return;
    const requested =
      initialCampaignId ?? new URLSearchParams(search).get("campaign");
    if (!requested || !demo.findCampaign(requested)) return;
    autoStarted.current = true;
    setSelectedId(requested);
    const saveId = demo.findLocalSave(requested);
    if (saveId) void resume(requested, saveId);
    else void start(requested);
    // `start` and `resume` are intentionally excluded below: this effect must fire once
    // on mount (guarded by `autoStarted`), and both functions are redefined every render,
    // so including them would either force this disable anyway or reintroduce the
    // repeated-start bug the ref exists to prevent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);

  /**
   * A first-ever visit lands on the "getting started" wizard instead of the disk shelf --
   * the landing page. It shares `autoStarted` with the `?campaign=` effect above (which runs
   * first and sets it when a direct link wins), so a real link is never pre-empted by this.
   * Marked seen the moment it starts, not on skip/finish: "first visit only" means once,
   * however that visit ends.
   */
  useEffect(() => {
    if (autoStarted.current) return;
    if (new URLSearchParams(search).has("admin")) return;
    if (initialCampaignId || hasSeenOnboarding()) return;
    if (!demo.findCampaign(GETTING_STARTED_CAMPAIGN_ID)) return;
    autoStarted.current = true;
    markOnboardingSeen();
    setSelectedId(GETTING_STARTED_CAMPAIGN_ID);
    void start(GETTING_STARTED_CAMPAIGN_ID);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);

  async function start(id: string) {
    const token = ++runToken.current;
    setBusy(true);
    setMessage(undefined);
    setSaveFailed(false);
    try {
      const next = await client.start(id);
      if (identity.kind === "anonymous" && demo.apiUrl) refreshIdentity(true);
      if (runToken.current !== token) return;
      setState(next);
      setCampaignId(id);
      setArrivalChoice(undefined);
      setJourney([{ excerpt: excerpt(next.scene.body.text) }]);
      setBbsResetToken((resetToken) => resetToken + 1);
      try {
        await client.save(next.sessionId);
        refreshRecords();
      } catch {
        if (runToken.current !== token) return;
        setSaveFailed(true);
        setMessage(demo.apiUrl ? "remoteSaveWarning" : "localSaveWarning");
      }
    } catch {
      if (runToken.current === token) setMessage("startError");
    } finally {
      if (runToken.current === token) setBusy(false);
    }
  }

  async function resume(id: string, saveId: string) {
    const token = ++runToken.current;
    setBusy(true);
    setMessage(undefined);
    setSaveFailed(false);
    try {
      const next = await client.load(saveId);
      if (runToken.current !== token) return;
      setState(next);
      setCampaignId(id);
      setArrivalChoice(undefined);
      setJourney([{ excerpt: excerpt(next.scene.body.text) }]);
      setBbsResetToken((resetToken) => resetToken + 1);
    } catch {
      if (runToken.current === token) setMessage("resumeError");
    } finally {
      if (runToken.current === token) setBusy(false);
    }
  }

  async function choose(id: string) {
    if (!state) return;
    const token = runToken.current;
    const resolvedLabel = state.actions.find(
      (action) => action.id === id,
    )?.label;
    setBusy(true);
    setMessage(undefined);
    setSaveFailed(false);
    try {
      const next = await client.submit(state, id);
      if (runToken.current !== token) return;
      setState(next.state);
      if (!next.result.ok) setMessage("rejected");
      else {
        if (resolvedLabel) {
          setArrivalChoice(resolvedLabel);
          setJourney((current) => [
            ...current,
            {
              choice: resolvedLabel,
              excerpt: excerpt(next.state.scene.body.text),
            },
          ]);
        }
        try {
          await client.save(next.state.sessionId);
          refreshRecords();
        } catch {
          if (runToken.current !== token) return;
          setSaveFailed(true);
          setMessage(demo.apiUrl ? "remoteSaveWarning" : "localSaveWarning");
        }
      }
    } catch {
      if (runToken.current === token) setMessage("actionError");
    } finally {
      if (runToken.current === token) setBusy(false);
    }
  }

  const returnToShelf = useCallback(() => {
    runToken.current += 1;
    if (campaignId) setSelectedId(campaignId);
    setState(undefined);
    setCampaignId(undefined);
    setMessage(undefined);
    setSaveFailed(false);
    setArrivalChoice(undefined);
    setJourney([]);
    setBusy(false);
    setBbsResetToken((token) => token + 1);
    onClose?.();
  }, [campaignId, onClose]);

  /**
   * The BBS Terminal prompt's only route into the game -- everything it can
   * do, a button on screen can also do, using the same numbering already
   * rendered (`DISK 01`, `.action-number`). A number outside the current
   * range gets its own message rather than the catch-all error below it, so
   * "I typed a real number, just the wrong one" reads differently from
   * genuinely unparseable input -- which answers with the actual GW-BASIC
   * `INPUT` error, the one joke in the theme.
   */
  function runCommand(raw: string): string | undefined {
    const upper = raw.toUpperCase();
    const index = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined;

    if (upper === "HELP" || upper === "?") {
      if (!state)
        return profileAvailable
          ? "Commands: [number] select a disk, LOAD, RESUME, PROFILE, HELP."
          : "Commands: [number] select a disk, LOAD, RESUME, HELP.";
      if (ended) return "Commands: AGAIN (or RESTART), QUIT, HELP.";
      return "Commands: [number] take that action, QUIT, HELP.";
    }

    if (!state) {
      if (upper === "PROFILE" && profileAvailable) {
        navigate("/profile");
        return undefined;
      }
      if (index !== undefined) {
        if (index >= 1 && index <= demo.catalog.length) {
          const campaign = demo.catalog[index - 1]!;
          setSelectedId(campaign.campaignId);
          return `Selected disk ${index}: ${campaign.title}.`;
        }
        return `Invalid choice. Type ${rangeLabel(demo.catalog.length)}.`;
      }
      if (upper === "LOAD" || upper === "GO") {
        if (!selected) return "?Redo from start";
        void start(selected.campaignId);
        return undefined;
      }
      if (upper === "RESUME") {
        if (!selected) return "?Redo from start";
        const saveId = demo.findLocalSave(selected.campaignId);
        if (!saveId) return "No saved run for this disk.";
        void resume(selected.campaignId, saveId);
        return undefined;
      }
      return "?Redo from start";
    }

    if (ended) {
      if (upper === "AGAIN" || upper === "RESTART") {
        if (campaignId) void start(campaignId);
        return undefined;
      }
      if (upper === "QUIT") {
        returnToShelf();
        return undefined;
      }
      return "?Redo from start";
    }

    if (upper === "QUIT") {
      returnToShelf();
      return undefined;
    }
    if (index !== undefined) {
      if (index >= 1 && index <= state.actions.length) {
        const action = state.actions[index - 1]!;
        if (!action.available)
          return `Unavailable: ${action.reason ?? "This choice is not available."}`;
        void choose(action.id);
        return undefined;
      }
      return `Invalid choice. Type ${rangeLabel(state.actions.length)}.`;
    }
    return "?Redo from start";
  }

  /** Reads like a real DOS path -- updates the moment a disk is selected, on the shelf or in play, not only once loaded. */
  const bbsSigil = selected
    ? `C:\\STORIES\\${dosName(selected.title)}>`
    : "C:\\STORIES>";
  const selectedSave =
    !state && selected ? demo.findLocalSave(selected.campaignId) : undefined;
  const bbsHint = !state
    ? selectedSave
      ? `Saved run found. Type RESUME to continue, or ${rangeLabel(demo.catalog.length)} for a different disk.`
      : `Type ${rangeLabel(demo.catalog.length)}, LOAD, RESUME, or HELP.`
    : ended
      ? "Type AGAIN, QUIT, or HELP."
      : `Type ${rangeLabel(state.actions.length)}, QUIT, or HELP.`;
  /** Any game-state change -- typed or mouse-driven -- hands focus back to the prompt. */
  const bbsFocusToken = `${selectedId ?? ""}|${campaignId ?? ""}|${sceneText ?? ""}|${ended}`;
  // Content administration keeps the same header and archive shell as the main surface;
  // it is an operator mode of the game, not a separate visual application.
  const isAdminPage = new URLSearchParams(search).has("admin");

  usePlayerShell({
    active,
    hidden: isOnboarding,
    title: !isAdminPage && state ? selected?.title : undefined,
    onSelectShelf: isAdminPage
      ? undefined
      : (onNavigateLibrary ?? returnToShelf),
  });

  if (initialCampaignId && !demo.findCampaign(initialCampaignId))
    return (
      <section>
        <h1>{t("missingCampaign")}</h1>
        <ResourceState
          state="error"
          error={new ApiError(404, "not_found", "Unknown campaign")}
        />
        <Link to="/">{t("library")}</Link>
      </section>
    );

  if (initialCampaignId && !state)
    return message ? (
      <section className="play-load-error" role="alert">
        <p>{t(message)}</p>
        <button
          className="app-button"
          disabled={busy}
          onClick={() => {
            const saveId = demo.findLocalSave(initialCampaignId);
            if (saveId) void resume(initialCampaignId, saveId);
            else void start(initialCampaignId);
          }}
        >
          {t("retry")}
        </button>
        <Link to="/">{t("library")}</Link>
      </section>
    ) : (
      <ResourceState state="loading" />
    );

  return (
    <>
      <div className="boot-flash" key={displayTheme} aria-hidden="true" />
      {isAdminPage ? (
        adminAccessLoading ? (
          <div className="play-loading" role="status">
            Checking admin access…
          </div>
        ) : isAdmin ? (
          <AdminPanel
            demo={demo}
            syncing={syncing}
            syncError={syncError}
            lastSyncedAt={lastSyncedAt}
            onSync={onSync}
          />
        ) : (
          <section
            className="archive admin"
            aria-labelledby="admin-denied-title"
          >
            <div className="archive-heading">
              <p className="eyebrow">RESTRICTED SYSTEM // ACCESS DENIED</p>
              <h1 id="admin-denied-title">Admin access required</h1>
              <p>
                This page is available only to an authorized signed-in account.
              </p>
              <Link className="cabinet-button" to="/">
                Return to disk library
              </Link>
            </div>
          </section>
        )
      ) : !state ? (
        <section className="archive" aria-labelledby="shelf-title">
          <div className="archive-heading">
            {demo.apiUrl && platformStats && (
              <PlatformStats
                stats={platformStats}
                catalogSize={demo.catalog.length}
              />
            )}
            <p className="eyebrow">SUBZERO STORY SYSTEM // INSERT DISK</p>
            <h1 id="shelf-title">Adventure disk library</h1>
            <p>
              Select a program. Your choices, bad luck, and improbable
              consequences run entirely on this machine.
            </p>
          </div>
          <div className="dossier-grid" aria-label="Story dossiers">
            {demo.catalog.map((campaign, index) => {
              const isSelected = selectedId === campaign.campaignId;
              // An odd-numbered catalog's final tile has no partner column, so it
              // spans both -- and drops the left/right column classing below, which
              // exists only to alternate a border between adjacent tiles.
              const isLastOdd =
                index === demo.catalog.length - 1 &&
                demo.catalog.length % 2 === 1;
              return (
                <div
                  key={campaign.campaignId}
                  className={[
                    "dossier-tile",
                    isLastOdd
                      ? "dossier-span-full"
                      : index % 2 === 0
                        ? "dossier-col-left"
                        : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <button
                    className={[
                      "dossier",
                      campaign.featured ? "dossier-featured" : "",
                      isSelected ? "is-selected" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => setSelectedId(campaign.campaignId)}
                    aria-pressed={isSelected}
                    aria-expanded={isSelected}
                  >
                    <span className="dossier-number">
                      DISK {String(index + 1).padStart(2, "0")} //{" "}
                      {campaign.mine
                        ? campaign.visibility === "public"
                          ? "PUBLISHED BY YOU"
                          : "PRIVATE"
                        : campaign.featured
                          ? "FEATURED"
                          : "READY"}
                    </span>
                    <strong>{campaign.title}</strong>
                    <span>{campaign.duration}</span>
                    {progress.get(campaign.campaignId) && (
                      <span className="dossier-progress">
                        {progressLabel(
                          campaign,
                          progress.get(campaign.campaignId)!,
                        )}
                      </span>
                    )}
                  </button>
                  {isSelected && (
                    <div className="dossier-brief">
                      <p className="dossier-description">
                        {campaign.description}
                      </p>
                      <div className="briefing-actions">
                        <button
                          className="cabinet-button primary"
                          disabled={busy}
                          onClick={() => void start(campaign.campaignId)}
                        >
                          Load
                        </button>
                        {demo.findLocalSave(campaign.campaignId) && (
                          <button
                            className="cabinet-button"
                            disabled={busy}
                            onClick={() =>
                              void resume(
                                campaign.campaignId,
                                demo.findLocalSave(campaign.campaignId)!,
                              )
                            }
                          >
                            Resume
                          </button>
                        )}
                      </div>
                      <p className="briefing-permalink">
                        <Link to={permalinkFor(campaign.campaignId)}>
                          {permalinkFor(campaign.campaignId)}
                        </Link>
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : (
        <section
          className={`cabinet accent-${cabinetTheme?.accent ?? "default"}${isOnboarding ? " onboarding" : ""}`}
          aria-label={`${selected?.title ?? "Story"} adventure terminal`}
        >
          <header className="cabinet-marquee">
            <div>
              <p className="eyebrow">
                {cabinetTheme?.eyebrow ?? "STORY IN PROGRESS"}
              </p>
              <h1>{selected?.title}</h1>
            </div>
            <div className="marquee-controls">
              {!isOnboarding && (
                <span
                  className={saveFailed ? "save-lamp warning" : "save-lamp"}
                >
                  <span aria-hidden="true" />{" "}
                  {t(busy ? "saving" : saveFailed ? "saveError" : "saved")}
                </span>
              )}
              <button className="cabinet-button quiet" onClick={returnToShelf}>
                {t(isOnboarding ? "skip" : "quit")}
              </button>
            </div>
          </header>
          <div className="cabinet-layout">
            <article className="scene-viewport" aria-live="polite">
              {ended ? (
                <>
                  <p className="scene-kicker">{t("complete")}</p>
                  <SceneRegion
                    key={sceneText}
                    text={state.scene.body.text}
                    regionRef={sceneRegion}
                    theme={displayTheme}
                  />
                  <ArrivalReceipt arrivalChoice={arrivalChoice} />
                  <div className="ending-controls">
                    <p className="ending-placard">
                      This matter has been concluded with excessive ceremony.
                    </p>
                    <button
                      className="cabinet-button primary"
                      disabled={busy}
                      onClick={() => void start(campaignId!)}
                    >
                      Start another run
                    </button>
                    {campaignId === demo.catalog[0]?.campaignId && (
                      <button
                        className="cabinet-button"
                        disabled={busy}
                        onClick={() => void start(campaignId!)}
                      >
                        {t("otherRole")}
                      </button>
                    )}
                    <button
                      className="cabinet-button quiet"
                      onClick={returnToShelf}
                    >
                      {t("returnStories")}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="scene-kicker">{t("room")}</p>
                  <SceneRegion
                    key={sceneText}
                    text={state.scene.body.text}
                    regionRef={sceneRegion}
                    theme={displayTheme}
                  />
                  <ArrivalReceipt arrivalChoice={arrivalChoice} />
                  <ActionDeck
                    actions={state.actions}
                    busy={busy}
                    terminal={displayTheme === "bbs"}
                    bbsSigil={bbsSigil}
                    onChoose={(id) => void choose(id)}
                  />
                </>
              )}
              {message && (
                <p className="play-message" role="status">
                  {t(message)}
                </p>
              )}
            </article>
            <StatusConsole
              state={state}
              selected={selected}
              journey={journey}
            />
          </div>
        </section>
      )}
      {showBbsPrompt && (
        <BbsPrompt
          sigil={bbsSigil}
          hint={bbsHint}
          focusToken={bbsFocusToken}
          resetToken={bbsResetToken}
          busy={busy}
          onCommand={runCommand}
        />
      )}
    </>
  );
}
