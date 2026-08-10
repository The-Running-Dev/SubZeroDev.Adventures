/**
 * The public standings page, reached via `/ranking` (main.tsx's routing) -- a standalone
 * top-level view mirroring `src/profile/PublicProfile.tsx`'s shape exactly: same `Stage`
 * union, same `apiUrl`-as-prop convention (read once by `main.tsx`, never
 * `import.meta.env` here, for the same testability reason `PublicProfile.tsx` documents),
 * same bare unauthenticated `fetch`.
 */
import { useEffect, useState } from "react";
import type { RankingData, RankingEntry } from "../play/identity";
import { positionTitleFor } from "../play/ranking";

const numberFormat = new Intl.NumberFormat();

type Stage =
  | { readonly kind: "unavailable" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "loaded"; readonly data: RankingData };

export function Ranking({ apiUrl }: { apiUrl?: string }) {
  const [stage, setStage] = useState<Stage>(
    apiUrl ? { kind: "loading" } : { kind: "unavailable" },
  );

  useEffect(() => {
    if (!apiUrl) {
      setStage({ kind: "unavailable" });
      return;
    }
    let cancelled = false;
    setStage({ kind: "loading" });

    fetch(`${apiUrl}/api/ranking`)
      .then((response) =>
        response.ok
          ? response.json().then((data: RankingData) => {
              if (!cancelled) setStage({ kind: "loaded", data });
            })
          : Promise.resolve().then(() => {
              if (!cancelled) setStage({ kind: "failed" });
            }),
      )
      .catch(() => {
        if (!cancelled) setStage({ kind: "failed" });
      });

    return () => {
      cancelled = true;
    };
  }, [apiUrl]);

  return (
    <main className="play-main">
      <section className="archive" aria-labelledby="ranking-title">
        <div className="archive-heading">
          <p className="eyebrow">SUBZERO STORY SYSTEM // STANDINGS</p>
          <h1 id="ranking-title">Operator standings</h1>
          <p>
            Every operator who made their record public, ordered by how much
            trouble they have generated. A private record is not a low score. It
            is an absence.
          </p>

          {stage.kind === "unavailable" && (
            <p className="profile-unavailable">
              Standings aren't available on this build.
            </p>
          )}
          {stage.kind === "loading" && (
            <p className="profile-unavailable" role="status">
              Compiling standings…
            </p>
          )}
          {stage.kind === "failed" && (
            <p className="profile-unavailable">
              The standings are not currently available. The system has no
              further comment.
            </p>
          )}
        </div>

        {stage.kind === "loaded" && <StandingsBoard data={stage.data} />}
      </section>
    </main>
  );
}

function StandingsBoard({ data }: { data: RankingData }) {
  if (data.entries.length === 0) {
    return (
      <p className="profile-unavailable">
        No public records on file. The ranking is technically complete.
      </p>
    );
  }

  const leader = data.entries.find((entry) => entry.crowned);

  return (
    <>
      {leader ? (
        <CrownBlock entry={leader} />
      ) : (
        <p className="profile-unavailable">
          Too few public records to crown anyone. The top of a list of two is
          not an achievement.
        </p>
      )}
      <div
        className="standings-scroll"
        tabIndex={0}
        role="region"
        aria-label="Operator standings"
      >
        <table className="standings-table">
          <caption className="sr-only">
            Operator standings, ranked by Absurdity Index
          </caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Operator</th>
              <th scope="col">Standing</th>
              <th scope="col">Absurdity index</th>
              <th scope="col">Badges</th>
              <th scope="col">Rejected moves</th>
              <th scope="col">Endings</th>
              <th scope="col">Moves</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((entry) => {
              const title = positionTitleFor(entry.position);
              return (
                <tr
                  key={entry.profileSlug}
                  className={entry.crowned ? "standings-crown-row" : undefined}
                >
                  <td className="standings-position">{entry.position}</td>
                  <td className="standings-operator">
                    <a href={`/u/${entry.profileSlug}`}>{entry.displayName}</a>
                  </td>
                  <td>{title.label}</td>
                  <td>{numberFormat.format(entry.absurdityIndex)}</td>
                  <td>{numberFormat.format(entry.badgeCount)}</td>
                  <td>{numberFormat.format(entry.rejected)}</td>
                  <td>{numberFormat.format(entry.endings)}</td>
                  <td>{numberFormat.format(entry.moves)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="standings-footnote">
        Index: 100 per badge, 5 per rejected move, 25 per ending, 1 per ten
        moves. Ties break toward more badges, then more rejected moves, then
        seniority. Rejected moves are counted by a column that also counts other
        things. The system stands by the number anyway.
      </p>
    </>
  );
}

function CrownBlock({ entry }: { entry: RankingEntry }) {
  const title = positionTitleFor(entry.position);
  return (
    <div className="profile-rank standings-crown" role="status">
      <span className="badge-emblem" aria-hidden="true">
        ◆
      </span>
      <div>
        <strong>{title.label}</strong>
        <span>{title.description}</span>
        <span className="badge-stamp">#1 // CURRENT — {entry.displayName}</span>
      </div>
    </div>
  );
}
