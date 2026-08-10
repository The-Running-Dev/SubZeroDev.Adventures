import { useState, type CSSProperties } from "react";
import type { BrowserCampaign } from "./composition";
import type {
  Badge,
  CampaignProgress,
  Identity,
  PersonnelRecords,
  ProfileSettings,
} from "./identity";
import { EARNABLE_BADGE_IDS, playEarnedBadgeCount } from "./badges";
import { ProfileRankBadge } from "./ProfileRankBadge";
import { BadgeGrid } from "./BadgeGrid";
import { PersonnelFile } from "./PersonnelFile";

const numberFormat = new Intl.NumberFormat();

function fill(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/**
 * The signed-in (or guest) player's own record: a summary derived entirely from the
 * `progress` map PlayApp.tsx already holds (no extra fetch), a grid of every badge --
 * earned or not -- and the public-profile toggle. Locked badges stay in the grid, dimmed
 * rather than removed, with an explicit `LOCKED` text stamp: the description is the
 * aspiration, and the stamp is what keeps locked/unlocked distinguishable once opacity is
 * stripped out under `forced-colors` or for a screen reader.
 */
export function PlayerHome({
  identity,
  progress,
  badges,
  records,
  catalog,
  settings,
  setPublic,
}: {
  identity: Identity;
  progress: ReadonlyMap<string, CampaignProgress>;
  badges: readonly Badge[];
  records: PersonnelRecords | null;
  catalog: readonly BrowserCampaign[];
  settings: ProfileSettings;
  setPublic: (next: boolean) => Promise<void>;
}) {
  const entries = [...progress.values()];
  const storiesFinished = entries.filter((e) => e.status === "ended").length;
  const movesLogged = entries.reduce((sum, e) => sum + e.stepCount, 0);
  const endingsFound = entries.reduce(
    (sum, e) => sum + e.endings.discovered.length,
    0,
  );
  const achievementsUnlocked = entries.reduce(
    (sum, e) => sum + e.achievements.length,
    0,
  );

  const earnedBadgeCount = playEarnedBadgeCount(badges);
  const finishedPct = fill(storiesFinished, catalog.length);
  const badgePct = fill(earnedBadgeCount, EARNABLE_BADGE_IDS.length);

  function findCampaignTitle(campaignId: string): string {
    return (
      catalog.find((c) => c.campaignId === campaignId)?.title ?? campaignId
    );
  }

  return (
    <section className="player-home" aria-labelledby="home-title">
      <p className="eyebrow">OPERATOR RECORD</p>
      <h2 id="home-title">{identity.displayName ?? "Guest operator"}</h2>
      {identity.kind === "guest" && (
        <p className="home-guest-note">
          Playing as a guest -- sign in to keep this record if you clear this
          browser.
        </p>
      )}
      <ProfileRankBadge badgeCount={earnedBadgeCount} />
      <dl className="home-summary">
        <div>
          <dt>Stories started</dt>
          <dd>{numberFormat.format(progress.size)}</dd>
        </div>
        <div
          className="stat-metered"
          style={{ "--stat-fill": `${finishedPct}%` } as CSSProperties}
        >
          <dt>Stories finished</dt>
          <dd>
            {numberFormat.format(storiesFinished)}
            <span className="stat-ceiling"> / {catalog.length}</span>
          </dd>
        </div>
        <div>
          <dt>Moves logged</dt>
          <dd>{numberFormat.format(movesLogged)}</dd>
        </div>
        <div>
          <dt>Endings found</dt>
          <dd>{numberFormat.format(endingsFound)}</dd>
        </div>
        <div>
          <dt>Achievements</dt>
          <dd>{numberFormat.format(achievementsUnlocked)}</dd>
        </div>
        <div
          className="stat-metered"
          style={{ "--stat-fill": `${badgePct}%` } as CSSProperties}
        >
          <dt>Badges</dt>
          <dd>
            {numberFormat.format(earnedBadgeCount)}
            <span className="stat-ceiling"> / {EARNABLE_BADGE_IDS.length}</span>
          </dd>
        </div>
      </dl>
      <ProfileShare settings={settings} setPublic={setPublic} />
      <BadgeGrid badges={badges} />
      <PersonnelFile records={records} findCampaignTitle={findCampaignTitle} />
    </section>
  );
}

/**
 * The public/private toggle plus, once public, a copyable `/u/<slug>` link.
 * `navigator.clipboard.writeText` is new to this codebase -- no existing precedent to
 * reuse (`AccountPanel.tsx`'s transfer-code UI shows/types codes manually, never
 * copies) -- so it gets its own try/catch-and-message handling here, matching that
 * component's `transferMessage` pattern in shape only.
 */
function ProfileShare({
  settings,
  setPublic,
}: {
  settings: ProfileSettings;
  setPublic: (next: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      await setPublic(!settings.public);
    } catch {
      setMessage("Couldn't update profile visibility. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const shareUrl = settings.slug
    ? `${window.location.origin}/u/${settings.slug}`
    : null;

  async function copyLink(): Promise<void> {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setMessage("Link copied.");
    } catch {
      setMessage("Couldn't copy the link. Select and copy it manually.");
    }
  }

  return (
    <div className="profile-share">
      <button
        className="cabinet-button"
        disabled={busy}
        onClick={() => void toggle()}
      >
        {settings.public ? "Make profile private" : "Make profile public"}
      </button>
      {settings.public && shareUrl && (
        <>
          <input
            type="text"
            readOnly
            value={shareUrl}
            aria-label="Public profile link"
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            className="cabinet-button quiet"
            onClick={() => void copyLink()}
          >
            Copy link
          </button>
        </>
      )}
      {message && <p className="account-error">{message}</p>}
    </div>
  );
}
