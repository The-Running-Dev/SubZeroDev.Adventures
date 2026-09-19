import { useTranslation } from "react-i18next";
import { ResourceState } from "../components/ResourceState";
import { useMyContent } from "./useMyContent";
import { SubmissionList } from "./SubmissionList";
import { SubmissionForms } from "./SubmissionForms";
export function MyContent({ apiUrl }: { apiUrl?: string }) {
  const { t } = useTranslation("content");
  const model = useMyContent(apiUrl);
  const { identity, identityLoading, ready, online, query } = model;
  return (
    <>
      <section
        className="feature-page archive admin"
        aria-labelledby="content-title"
      >
        <div className="archive-heading">
          <p className="eyebrow">{t("eyebrow")}</p>
          <h1 id="content-title">{t("title")}</h1>
          <p className="admin-note">{t("intro")}</p>

          {!apiUrl && <p className="profile-unavailable">{t("unavailable")}</p>}
          {apiUrl && identityLoading && (
            <p className="profile-unavailable" role="status">
              {t("loading")}
            </p>
          )}
          {apiUrl && !identityLoading && identity.kind === "anonymous" && (
            <p className="profile-unavailable">{t("anonymous")}</p>
          )}
        </div>

        {ready && !online && <ResourceState state="offline" />}
        {ready && query.isPending && <ResourceState state="loading" />}
        {ready && query.isError && (
          <ResourceState
            state="error"
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        )}
        {ready && !query.isPending && !query.isError && (
          <>
            <SubmissionList {...model} />

            <SubmissionForms {...model} />
          </>
        )}
      </section>
    </>
  );
}
