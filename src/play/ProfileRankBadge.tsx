import { profileRankFor } from "./badges";

/** The "badge of a badge" -- a single prominent tile summarizing overall progress,
 *  shared verbatim between the owner's own "Your record" view and a visitor's public
 *  profile, so both read the same rank the same way. */
export function ProfileRankBadge({ badgeCount }: { badgeCount: number }) {
  const rank = profileRankFor(badgeCount);
  return (
    <div className="profile-rank" role="status">
      <span className="badge-emblem" aria-hidden="true">
        ◆
      </span>
      <div>
        <strong>{rank.label}</strong>
        <span>{rank.description}</span>
      </div>
    </div>
  );
}
