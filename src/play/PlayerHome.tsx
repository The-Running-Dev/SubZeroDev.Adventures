import { useOnline } from "../pwa/usePwa";
import { useTranslation } from "react-i18next";
import { useLocale } from "../app/locale/useLocale";
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
  const { t } = useTranslation("community");
  const { number } = useLocale();
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
      <p className="eyebrow">{t("record")}</p>
      <h2 id="home-title">{identity.displayName ?? t("guest")}</h2>
      {identity.kind === "guest" && (
        <p className="home-guest-note">{t("guestNote")}</p>
      )}
      <ProfileRankBadge badgeCount={earnedBadgeCount} />
      <dl className="home-summary">
        <div>
          <dt>{t("started")}</dt>
          <dd>{number(progress.size)}</dd>
        </div>
        <div
          className="stat-metered"
          style={{ "--stat-fill": `${finishedPct}%` } as CSSProperties}
        >
          <dt>{t("finished")}</dt>
          <dd>
            {number(storiesFinished)}
            <span className="stat-ceiling"> / {catalog.length}</span>
          </dd>
        </div>
        <div>
          <dt>{t("logged")}</dt>
          <dd>{number(movesLogged)}</dd>
        </div>
        <div>
          <dt>{t("found")}</dt>
          <dd>{number(endingsFound)}</dd>
        </div>
        <div>
          <dt>{t("achievements")}</dt>
          <dd>{number(achievementsUnlocked)}</dd>
        </div>
        <div
          className="stat-metered"
          style={{ "--stat-fill": `${badgePct}%` } as CSSProperties}
        >
          <dt>{t("badges")}</dt>
          <dd>
            {number(earnedBadgeCount)}
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
  const { t } = useTranslation("community");

  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      await setPublic(!settings.public);
    } catch {
      setMessage("visibilityError");
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
      setMessage("copied");
    } catch {
      setMessage("copyError");
    }
  }

  return (
    <div className="profile-share">
      <button
        className="cabinet-button"
        disabled={busy || !online}
        onClick={() => void toggle()}
      >
        {settings.public ? t("makePrivate") : t("makePublic")}
      </button>
      {settings.public && shareUrl && (
        <>
          <input
            type="text"
            readOnly
            value={shareUrl}
            aria-label={t("profileLink")}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            className="cabinet-button quiet"
            onClick={() => void copyLink()}
          >
            {t("copy")}
          </button>
        </>
      )}
      {message && <p className="account-error">{t(message)}</p>}
    </div>
  );
}
