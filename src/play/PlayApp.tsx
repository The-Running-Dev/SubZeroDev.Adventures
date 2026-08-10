import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from "react";
import { Header } from "../Header";
import {
  applyTheme,
  DEFAULT_THEME,
  readStoredTheme,
  storeTheme,
} from "../theme";
import type { ThemeId } from "../theme";
import { AccountPanel } from "./AccountPanel";
import { BbsPrompt } from "./BbsPrompt";
import { BrowserClient, type PlayState } from "./browser-client";
import {
  createBrowserDemo,
  type BrowserCampaign,
  type BrowserDemo,
  type StatBounds,
} from "./composition";
import {
  consumeAuthError,
  useIdentity,
  usePlatformStats,
  useProgress,
  type CampaignProgress,
} from "./identity";
import { MatrixRain } from "./MatrixRain";
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
};

interface Stat {
  readonly var: string;
  readonly labelKey: string;
  readonly value: string | number | boolean;
}

function viewOf(state: PlayState) {
  const view = state.view.kindView as {
    stats?: Stat[];
    unlockedAchievements?: string[];
    turn?: number;
  };
  return {
    stats: view.stats ?? [],
    achievements: view.unlockedAchievements ?? [],
    turn: view.turn,
  };
}

interface JourneyEntry {
  readonly excerpt: string;
  readonly choice?: string;
}

const saveWarning =
  "Progress could not be saved locally; this run remains available in this tab.";

/** A permanent, shareable link that loads a campaign directly -- no click-through required. */
function permalinkFor(campaignId: string): string {
  return `${window.location.origin}${window.location.pathname}?campaign=${encodeURIComponent(campaignId)}`;
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

/** A brisk reveal, not a literal words-per-minute simulation -- floors and caps keep very short or very long excerpts from feeling instant or endless. */
const REVEAL_CHARS_PER_SECOND = 55;
const REVEAL_MIN_MS = 400;
const REVEAL_MAX_MS = 900;
/** Matrix reads slightly slower than the other skins -- part of its distinct pacing. */
const MATRIX_REVEAL_MULTIPLIER = 1.25;

function revealDuration(text: string, theme: ThemeId): number {
  const raw = (text.length / REVEAL_CHARS_PER_SECOND) * 1000;
  const clamped = Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, raw));
  return theme === "matrix" ? clamped * MATRIX_REVEAL_MULTIPLIER : clamped;
}

/**
 * A labelled region with a short real heading, not the authored prose
 * itself -- a paragraph marked up as a heading makes the phone
 * screen-reader's heading rotor return a wall of story instead of a
 * landmark (14 §8.5).
 *
 * The story text is split into per-character spans, each with its own
 * `animation-delay`, so it visibly prints one character at a time rather
 * than as a single block-wide wipe. Every character is present in the DOM
 * from the first render -- only its `opacity` is staggered -- so
 * `textContent` is complete immediately: no test or screen reader has to
 * wait out the reveal to see the full scene.
 */
function SceneRegion({
  text,
  regionRef,
  theme,
}: {
  text: string;
  regionRef: RefObject<HTMLElement | null>;
  theme: ThemeId;
}) {
  const chars = useMemo(() => Array.from(text), [text]);
  const total = revealDuration(text, theme);
  const perChar = chars.length ? total / chars.length : 0;
  return (
    <section
      ref={regionRef}
      tabIndex={-1}
      aria-labelledby="scene-heading"
      className="scene-region"
    >
      <h2 id="scene-heading" className="sr-only">
        Scene
      </h2>
      <p
        className="scene-body"
        style={{ "--reveal-total": `${total}ms` } as CSSProperties}
      >
        {chars.map((char, index) => (
          <span key={index} style={{ animationDelay: `${index * perChar}ms` }}>
            {char}
          </span>
        ))}
      </p>
    </section>
  );
}

const NO_STATS: ReadonlySet<string> = new Set();
/**
 * Long enough to notice on a glance back at the panel, short enough that a stat
 * which moved two turns ago is not still lit. Kept in step with the
 * `.stat-changed` animation duration in play.css.
 */
const STAT_HIGHLIGHT_MS = 1100;

/**
 * Which stats changed on the turn just committed.
 *
 * A stat moving is this game's main feedback signal, and the projection reports
 * only the *new* value -- after a turn, "3" is indistinguishable from "3 again"
 * without remembering what the previous turn showed. Comparing against the
 * previously rendered values is what makes the change visible at all.
 *
 * Nothing is highlighted on a run's first render (every stat is new, not
 * changed), which is what keeps a freshly loaded story from flashing all eight
 * readouts at once. State lives in a signature string rather than the `stats`
 * array because `viewOf` builds a fresh array every render -- depending on the
 * array itself would re-run this on every render, not on every actual change.
 */
function useChangedStats(stats: readonly Stat[]): ReadonlySet<string> {
  /*
   * JSON rather than a delimiter-joined string: an `enum` stat's value is
   * authored content, so there is no separator this could assume it is free of.
   */
  const signature = JSON.stringify(
    Object.fromEntries(stats.map((stat) => [stat.var, String(stat.value)])),
  );
  const previous = useRef<string | undefined>(undefined);
  const [changed, setChanged] = useState<ReadonlySet<string>>(NO_STATS);

  useEffect(() => {
    const before = previous.current;
    previous.current = signature;
    if (before === undefined || before === signature) return;

    const past = JSON.parse(before) as Record<string, string>;
    const now = JSON.parse(signature) as Record<string, string>;
    const moved = new Set(
      Object.keys(now).filter(
        (name) => past[name] !== undefined && past[name] !== now[name],
      ),
    );
    if (moved.size === 0) return;

    setChanged(moved);
    const timer = setTimeout(() => setChanged(NO_STATS), STAT_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [signature]);

  return changed;
}

/**
 * The player-visible stats.
 *
 * A bounded int renders as `value / max` over a meter rather than a bare
 * number: the campaign declares the range (`predictions_correct` is 0-26, i.e.
 * a score out of 26), and without the denominator the panel shows a count with
 * nothing to read it against. Bounds come from the campaign this client already
 * fetched, since the projection deliberately carries the value alone.
 *
 * A stat still sitting at its floor is dimmed rather than hidden -- the set of
 * stats is itself a hint about what the story measures, so dropping the
 * untouched ones would hide the shape of the run, but leaving them at full
 * strength is what makes an all-zero panel read as noise.
 */
function StatReadouts({
  stats,
  strings,
  bounds,
}: {
  stats: readonly Stat[];
  strings: PlayState["strings"];
  bounds: Readonly<Record<string, StatBounds>>;
}) {
  const changed = useChangedStats(stats);
  return (
    <dl className="stat-readouts">
      {stats.map((stat) => {
        const range = bounds[stat.var];
        const floor = range?.min ?? 0;
        const ceiling = range?.max;
        const numeric = typeof stat.value === "number";
        const metered = numeric && ceiling !== undefined && ceiling > floor;
        const className = [
          numeric && stat.value === floor ? "stat-idle" : "",
          metered ? "stat-metered" : "",
          changed.has(stat.var) ? "stat-changed" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div
            key={stat.var}
            {...(className ? { className } : {})}
            {...(metered
              ? {
                  style: {
                    "--stat-fill": `${Math.round(
                      (((stat.value as number) - floor) / (ceiling! - floor)) *
                        100,
                    )}%`,
                  } as CSSProperties,
                }
              : {})}
          >
            <dt>{strings[stat.labelKey]}</dt>
            <dd>
              {String(stat.value)}
              {ceiling !== undefined && (
                <span className="stat-ceiling"> / {ceiling}</span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function ArrivalReceipt({ arrivalChoice }: { arrivalChoice?: string }) {
  return (
    <div className="arrival-receipt" role="status">
      {arrivalChoice ? (
        <>
          <span>Last command</span>
          <strong>{arrivalChoice}</strong>
          <span className="arrival-link">// accepted</span>
        </>
      ) : (
        <strong>PROGRAM LOADED. YOUR STORY BEGINS HERE.</strong>
      )}
    </div>
  );
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
export default function PlayApp() {
  const [demo, setDemo] = useState<BrowserDemo>();
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    createBrowserDemo()
      .then((loaded) => {
        if (!cancelled) setDemo(loaded);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return (
      <div className="play-load-error" role="alert">
        The playable catalog could not be loaded: {loadError}
      </div>
    );
  }
  if (!demo) {
    return (
      <div className="play-loading" role="status">
        Loading catalog…
      </div>
    );
  }
  return <PlayAppReady demo={demo} />;
}

function PlayAppReady({ demo }: { demo: BrowserDemo }) {
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
  const [displayTheme, setDisplayTheme] = useState<ThemeId>(DEFAULT_THEME);

  // Account chip + progress panel (AccountPanel.tsx) -- only meaningful in remote mode,
  // where `demo.apiUrl` is set (composition.ts). `identityRefreshToken` bumps after a
  // sign-in/out/transfer round trip to re-fetch `/api/me` and `/api/progress`.
  const [identityRefreshToken, setIdentityRefreshToken] = useState(0);
  const { identity, loading: identityLoading } = useIdentity(
    demo.apiUrl,
    identityRefreshToken,
  );
  const progress = useProgress(demo.apiUrl, identity.playerId);
  const platformStats = usePlatformStats(demo.apiUrl);
  const [authError] = useState(() => consumeAuthError());
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
    if (sceneText && !showBbsPrompt)
      sceneRegion.current?.focus({ preventScroll: true });
  }, [sceneText, showBbsPrompt]);

  /**
   * Starting or resuming a run replaces the whole shelf with the cabinet, but leaves
   * whatever scroll position clicking "Load"/"Resume" (now inside a folded-open dossier
   * tile, possibly off the first screen) left behind -- the phone reading model's
   * promise that the scene and its choices need no scroll (14 §8.2) only holds if the
   * cabinet actually opens at the top. `behavior: "auto"`, not the page's default smooth
   * scroll, since this is a state transition, not a scroll the player asked for. Keyed
   * on `campaignId`, which is set once per run, not once per turn.
   */
  useEffect(() => {
    if (campaignId) window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [campaignId]);

  useEffect(() => {
    const stored = readStoredTheme();
    setDisplayTheme(stored);
    applyTheme(stored);
  }, []);

  function changeTheme(id: ThemeId) {
    setDisplayTheme(id);
    applyTheme(id);
    storeTheme(id);
  }

  /**
   * A permanent `?campaign=` link loads the adventure directly -- no dossier click, no
   * briefing step. A hidden campaign has no dossier tile at all, so this is its only door in.
   */
  useEffect(() => {
    if (autoStarted.current) return;
    const requested = new URLSearchParams(window.location.search).get(
      "campaign",
    );
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

  async function start(id: string) {
    const token = ++runToken.current;
    setBusy(true);
    setMessage(undefined);
    setSaveFailed(false);
    try {
      const next = await client.start(id);
      if (runToken.current !== token) return;
      setState(next);
      setCampaignId(id);
      setArrivalChoice(undefined);
      setJourney([{ excerpt: excerpt(next.scene.body.text) }]);
      setBbsResetToken((resetToken) => resetToken + 1);
      try {
        await client.save(next.sessionId);
      } catch {
        if (runToken.current !== token) return;
        setSaveFailed(true);
        setMessage(saveWarning);
      }
    } catch {
      if (runToken.current === token) setMessage("This story could not start.");
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
      if (runToken.current === token)
        setMessage("This saved run could not be loaded.");
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
      if (!next.result.ok)
        setMessage("That action was rejected. The scene has not changed.");
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
        } catch {
          if (runToken.current !== token) return;
          setSaveFailed(true);
          setMessage(saveWarning);
        }
      }
    } catch {
      if (runToken.current === token)
        setMessage("That action could not be completed.");
    } finally {
      if (runToken.current === token) setBusy(false);
    }
  }

  function returnToShelf() {
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
  }

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
        window.location.assign("/profile");
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

  return (
    <>
      {displayTheme === "matrix" && <MatrixRain />}
      <main className="play-main">
        <div className="boot-flash" key={displayTheme} aria-hidden="true" />
        <Header
          current={state ? "playing" : "shelf"}
          playingTitle={selected?.title}
          onSelectShelf={returnToShelf}
          theme={displayTheme}
          onThemeChange={changeTheme}
        >
          {demo.apiUrl && (
            <AccountPanel
              apiUrl={demo.apiUrl}
              identity={identity}
              loading={identityLoading}
              authError={authError}
              onChanged={() => setIdentityRefreshToken((token) => token + 1)}
              profileAvailable={profileAvailable}
            />
          )}
        </Header>
        {!state ? (
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
                        {campaign.featured ? "FEATURED" : "READY"}
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
                        <p>{campaign.description}</p>
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
                          <a href={permalinkFor(campaign.campaignId)}>
                            {permalinkFor(campaign.campaignId)}
                          </a>
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
            className={`cabinet accent-${cabinetTheme?.accent ?? "default"}`}
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
                <span
                  className={saveFailed ? "save-lamp warning" : "save-lamp"}
                >
                  <span aria-hidden="true" />{" "}
                  {saveFailed ? "DISK WRITE ERROR" : "GAME SAVED"}
                </span>
                <button
                  className="cabinet-button quiet"
                  onClick={returnToShelf}
                >
                  Quit to library
                </button>
              </div>
            </header>
            <div className="cabinet-layout">
              <article className="scene-viewport" aria-live="polite">
                {ended ? (
                  <>
                    <p className="scene-kicker">SESSION COMPLETE</p>
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
                          Play the other role
                        </button>
                      )}
                      <button
                        className="cabinet-button quiet"
                        onClick={returnToShelf}
                      >
                        Return to stories
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="scene-kicker">ROOM DESCRIPTION</p>
                    <SceneRegion
                      key={sceneText}
                      text={state.scene.body.text}
                      regionRef={sceneRegion}
                      theme={displayTheme}
                    />
                    <ArrivalReceipt arrivalChoice={arrivalChoice} />
                    <div
                      className="action-deck"
                      aria-label="Available actions"
                      aria-busy={busy}
                    >
                      <p className="deck-label">
                        {displayTheme === "bbs" && `${bbsSigil} `}
                        What will you do?
                      </p>
                      {state.actions.map((action, index) => (
                        <div
                          className={`action-card ${!action.available ? "unavailable" : ""}`}
                          key={action.id}
                        >
                          <button
                            disabled={busy || !action.available}
                            onClick={() => choose(action.id)}
                          >
                            <span className="action-number" aria-hidden="true">
                              {index + 1}
                            </span>
                            {action.label}
                          </button>
                          {!action.available && (
                            <p className="play-reason">
                              Unavailable: {action.reason}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {message && (
                  <p className="play-message" role="status">
                    {message}
                  </p>
                )}
              </article>
              <aside className="status-console" aria-labelledby="console-title">
                <div className="console-heading">
                  <p className="eyebrow">SIDE PANEL // MEMORY</p>
                  <h2 id="console-title">Player status</h2>
                  {viewOf(state).turn !== undefined && (
                    <p className="turn-readout">Turn {viewOf(state).turn}</p>
                  )}
                </div>
                {viewOf(state).stats.length ? (
                  <StatReadouts
                    stats={viewOf(state).stats}
                    strings={state.strings}
                    bounds={selected?.statBounds ?? {}}
                  />
                ) : (
                  <p className="console-empty">
                    No visible statistics have been authorized for this case.
                  </p>
                )}
                {viewOf(state).achievements.length > 0 && (
                  <p className="achievement-note">
                    <span aria-hidden="true">◆ </span>
                    Achievement stamps: {viewOf(state).achievements.length}
                  </p>
                )}
                {/*
                 * Open by default: this is the run's own history, it fills the
                 * console's otherwise-dead lower half on desktop, and behind a
                 * collapsed `[+]` most players never find it. `open` is set
                 * once, not controlled -- React only rewrites the attribute
                 * when the prop value changes, so closing it stays closed.
                 */}
                <details className="journey-log" open>
                  <summary>
                    Travel log
                    <span className="journey-count">
                      {journey.length} {journey.length === 1 ? "page" : "pages"}
                    </span>
                  </summary>
                  <ol>
                    {journey.map((entry, index) => (
                      <li
                        key={`${index}-${entry.excerpt}`}
                        aria-current={
                          index === journey.length - 1 ? "step" : undefined
                        }
                      >
                        {entry.choice && (
                          <strong>You chose {entry.choice}. </strong>
                        )}
                        <span>{entry.excerpt}</span>
                        {index === journey.length - 1 && <em> Current page</em>}
                      </li>
                    ))}
                  </ol>
                  {journey.length > 1 && (
                    <p className="journey-origin">
                      Where I came from: {journey[journey.length - 2]?.excerpt}
                    </p>
                  )}
                </details>
                <p className="console-footnote">
                  Player-visible memory only. No engine internals displayed.
                </p>
                {selected?.sources && (
                  <div className="source-links">
                    <h3>Sources / credits</h3>
                    {selected.sources.map((source) => (
                      <a key={source.href} href={source.href}>
                        {source.label}
                      </a>
                    ))}
                  </div>
                )}
              </aside>
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
      </main>
    </>
  );
}
