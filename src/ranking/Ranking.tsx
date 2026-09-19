import { Button } from "../components/Button";
import { useTranslation } from "react-i18next";
import { useLocale } from "../app/locale/useLocale";
import { Link } from "react-router";
/**
 * The public standings page, reached via `/ranking` (main.tsx's routing) -- a standalone
 * top-level view mirroring `src/profile/PublicProfile.tsx`'s shape exactly: same `Stage`
 * union, same `apiUrl`-as-prop convention (read once by `main.tsx`, never
 * `import.meta.env` here, for the same testability reason `PublicProfile.tsx` documents),
 * same bare unauthenticated `fetch`.
 */
import { useQuery } from "@tanstack/react-query";
import { getRanking } from "../api/ranking";
import type { RankingData, RankingEntry } from "../play/identity";
import { positionTitleFor } from "../play/ranking";

type Stage =
  | { readonly kind: "unavailable" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "loaded"; readonly data: RankingData };

export function Ranking({ apiUrl }: { apiUrl?: string }) {
  const { t } = useTranslation("community");

  const query = useQuery({
    queryKey: ["public", apiUrl, "ranking"],
    queryFn: ({ signal }) => getRanking(apiUrl, signal),
    enabled: Boolean(apiUrl),
  });
  const stage: Stage = !apiUrl
    ? { kind: "unavailable" }
    : query.isPending
      ? { kind: "loading" }
      : query.isError
        ? { kind: "failed" }
        : { kind: "loaded", data: query.data };

  return (
    <>
      <section className="feature-page archive" aria-labelledby="ranking-title">
        <div className="archive-heading">
          <p className="eyebrow">{t("rankingEyebrow")}</p>
          <h1 id="ranking-title">{t("rankingTitle")}</h1>
          <p>{t("rankingIntro")}</p>

          {stage.kind === "unavailable" && (
            <p className="profile-unavailable">{t("rankingUnavailable")}</p>
          )}
          {stage.kind === "loading" && (
            <p className="profile-unavailable" role="status">
              {t("rankingLoading")}
            </p>
          )}
          {stage.kind === "failed" && (
            <div role="alert">
              <p>{t("rankingFailed")}</p>
              <Button onClick={() => void query.refetch()}>
                {t("common:retry")}
              </Button>
            </div>
          )}
        </div>

        {stage.kind === "loaded" && <StandingsBoard data={stage.data} />}
      </section>
    </>
  );
}

function StandingsBoard({ data }: { data: RankingData }) {
  const { t } = useTranslation("community");
  const { number } = useLocale();
  if (data.entries.length === 0) {
    return <p className="profile-unavailable">{t("rankingEmpty")}</p>;
  }

  const leader = data.entries.find((entry) => entry.crowned);

  return (
    <>
      {leader ? (
        <CrownBlock entry={leader} />
      ) : (
        <p className="profile-unavailable">{t("noCrown")}</p>
      )}
      <div
        className="standings-scroll"
        tabIndex={0}
        role="region"
        aria-label={t("rankingTitle")}
      >
        <table className="standings-table">
          <caption className="sr-only">{t("rankingCaption")}</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{t("operator")}</th>
              <th scope="col">{t("standing")}</th>
              <th scope="col">{t("index")}</th>
              <th scope="col">{t("badges")}</th>
              <th scope="col">{t("rejected")}</th>
              <th scope="col">{t("endings")}</th>
              <th scope="col">{t("moves")}</th>
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
                    <Link to={`/u/${entry.profileSlug}`}>
                      {entry.displayName}
                    </Link>
                  </td>
                  <td>{t(`positions.${title.label}.label`)}</td>
                  <td>{number(entry.absurdityIndex)}</td>
                  <td>{number(entry.badgeCount)}</td>
                  <td>{number(entry.rejected)}</td>
                  <td>{number(entry.endings)}</td>
                  <td>{number(entry.moves)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="standings-footnote">{t("rankingFootnote")}</p>
    </>
  );
}

function CrownBlock({ entry }: { entry: RankingEntry }) {
  const { t } = useTranslation("community");

  const title = positionTitleFor(entry.position);
  return (
    <div className="profile-rank standings-crown" role="status">
      <span className="badge-emblem" aria-hidden="true">
        ◆
      </span>
      <div>
        <strong>{t(`positions.${title.label}.label`)}</strong>
        <span>{t(`positions.${title.label}.description`)}</span>
        <span className="badge-stamp">
          {t("current", { name: entry.displayName })}
        </span>
      </div>
    </div>
  );
}
