import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { ThemeSelector } from "../ThemeSelector";
import {
  applyTheme,
  DEFAULT_THEME,
  readStoredTheme,
  storeTheme,
} from "../theme";
import type { ThemeId } from "../theme";
import { BbsPrompt } from "./BbsPrompt";
import { BrowserClient, type PlayState } from "./browser-client";
import { createBrowserDemo, type BrowserDemo } from "./composition";
import { MatrixRain } from "./MatrixRain";

const cabinetThemes: Readonly<
  Record<string, { accent: string; eyebrow: string }>
> = {
  "lucifer-chronicles": { accent: "ember", eyebrow: "CELESTIAL CASE FILE" },
  "bulgaria-bureaucracy": { accent: "red", eyebrow: "MUNICIPAL ARCHIVE" },
  "bulgaria-return": { accent: "teal", eyebrow: "RETURN DEPARTMENT" },
  "bulgaria-driving": { accent: "yellow", eyebrow: "ROAD SAFETY OFFICE" },
  "bulgaria-inheritance": { accent: "green", eyebrow: "ESTATE RECORDS" },
  "bulgaria-enterprise": { accent: "violet", eyebrow: "ENTERPRISE DESK" },
};

function viewOf(state: PlayState) {
  const view = state.view.kindView as {
    stats?: {
      var: string;
      labelKey: string;
      value: string | number | boolean;
    }[];
    unlockedAchievements?: string[];
  };
  return {
    stats: view.stats ?? [],
    achievements: view.unlockedAchievements ?? [],
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
  /** Bumped on every return to the shelf, so the BBS prompt can clear its stale response/input independently of ordinary in-game state changes. */
  const [bbsResetToken, setBbsResetToken] = useState(0);
  const [displayTheme, setDisplayTheme] = useState<ThemeId>(DEFAULT_THEME);
  const sceneRegion = useRef<HTMLElement>(null);
  const scenePage = useRef<HTMLDivElement>(null);
  const choicePage = useRef<HTMLDivElement>(null);
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
   * usual scene-focus handoff would just fight it on every turn.
   */
  useEffect(() => {
    if (sceneText && displayTheme !== "bbs") sceneRegion.current?.focus();
  }, [sceneText, displayTheme]);

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
  }, [demo]);

  function reducedMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function scrollToChoices() {
    choicePage.current?.scrollIntoView({
      behavior: reducedMotion() ? "auto" : "smooth",
      block: "start",
    });
  }

  function scrollToScene() {
    scenePage.current?.scrollIntoView({
      behavior: reducedMotion() ? "auto" : "smooth",
      block: "start",
    });
  }

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
        return "Commands: [number] select a disk, LOAD, RESUME, HELP.";
      if (ended) return "Commands: AGAIN (or RESTART), QUIT, HELP.";
      return "Commands: [number] take that action, QUIT, HELP.";
    }

    if (!state) {
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
        <ThemeSelector theme={displayTheme} onChange={changeTheme} />
        {!state ? (
          <section className="archive" aria-labelledby="shelf-title">
            <div className="archive-heading">
              <p className="eyebrow">SUBZERO STORY SYSTEM // INSERT DISK</p>
              <h1 id="shelf-title">Adventure disk library</h1>
              <p>
                Select a program. Your choices, bad luck, and improbable
                consequences run entirely on this machine.
              </p>
            </div>
            <div className="dossier-grid" aria-label="Story dossiers">
              {demo.catalog.map((campaign, index) => (
                <button
                  className={`dossier ${campaign.featured ? "dossier-featured" : ""} ${selectedId === campaign.campaignId ? "is-selected" : ""}`}
                  key={campaign.campaignId}
                  onClick={() => setSelectedId(campaign.campaignId)}
                  aria-pressed={selectedId === campaign.campaignId}
                >
                  <span className="dossier-number">
                    DISK {String(index + 1).padStart(2, "0")} //{" "}
                    {campaign.featured ? "FEATURED" : "READY"}
                  </span>
                  <strong>{campaign.title}</strong>
                  <span>{campaign.duration}</span>
                </button>
              ))}
            </div>
            {selected && (
              <section className="briefing" aria-labelledby="briefing-title">
                <div
                  className={`briefing-emblem accent-${cabinetThemes[selected.campaignId]?.accent ?? "default"}`}
                  aria-hidden="true"
                >
                  ⌘
                </div>
                <div>
                  <p className="eyebrow">
                    {cabinetThemes[selected.campaignId]?.eyebrow ??
                      "UNCLASSIFIED STORY"}
                  </p>
                  <h2 id="briefing-title">{selected.title}</h2>
                  <p>{selected.description}</p>
                  <p className="briefing-meta">
                    Estimated duration: {selected.duration}
                  </p>
                  {selected.contentNotice && (
                    <p className="briefing-advisory">
                      {selected.contentNotice}
                    </p>
                  )}
                  <div className="briefing-actions">
                    <button
                      className="cabinet-button primary"
                      disabled={busy}
                      onClick={() => void start(selected.campaignId)}
                    >
                      Load selected adventure
                    </button>
                    {demo.findLocalSave(selected.campaignId) && (
                      <button
                        className="cabinet-button"
                        disabled={busy}
                        onClick={() =>
                          void resume(
                            selected.campaignId,
                            demo.findLocalSave(selected.campaignId)!,
                          )
                        }
                      >
                        Resume saved run
                      </button>
                    )}
                  </div>
                  <p className="briefing-permalink">
                    Permanent link:{" "}
                    <a href={permalinkFor(selected.campaignId)}>
                      {permalinkFor(selected.campaignId)}
                    </a>
                  </p>
                </div>
              </section>
            )}
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
                    <div className="scene-page" ref={scenePage}>
                      <p className="scene-kicker">ROOM DESCRIPTION</p>
                      <SceneRegion
                        key={sceneText}
                        text={state.scene.body.text}
                        regionRef={sceneRegion}
                        theme={displayTheme}
                      />
                      <ArrivalReceipt arrivalChoice={arrivalChoice} />
                      <button
                        type="button"
                        className="scene-cue"
                        onClick={scrollToChoices}
                      >
                        {state.actions.length}{" "}
                        {state.actions.length === 1 ? "choice" : "choices"} ⌄
                      </button>
                    </div>
                    <div className="choice-page" ref={choicePage}>
                      <div className="scene-echo">
                        <button type="button" onClick={scrollToScene}>
                          Scene: {state.scene.body.text}
                        </button>
                      </div>
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
                              <span
                                className="action-number"
                                aria-hidden="true"
                              >
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
                </div>
                {viewOf(state).stats.length ? (
                  <dl className="stat-readouts">
                    {viewOf(state).stats.map((stat) => (
                      <div key={stat.var}>
                        <dt>{state.strings[stat.labelKey]}</dt>
                        <dd>{String(stat.value)}</dd>
                      </div>
                    ))}
                  </dl>
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
                <details className="journey-log">
                  <summary>Travel log</summary>
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
        {displayTheme === "bbs" && (
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
