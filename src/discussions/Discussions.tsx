import { ResourceState } from "../components/ResourceState";
import { Button } from "../components/Button";
import { useOnline } from "../pwa/usePwa";
import { useTranslation } from "react-i18next";
import { useLocale } from "../app/locale/useLocale";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import {
  getDiscussion,
  getDiscussions,
  postDiscussion,
} from "../api/discussions";
import { Link } from "react-router";
import { useAccount } from "../app/providers/AccountProvider";
/**
 * `/discussions` and `/discussions/<id>`, reached via `main.tsx`'s routing -- a
 * purpose-built forum page over this repository's GitHub Discussions
 * (`server/src/routes/discussions.ts`), mirroring `src/ranking/Ranking.tsx`'s shape:
 * same `apiUrl`-as-prop convention (read once by `main.tsx`, never `import.meta.env`
 * here), shared AppShell theme and navigation. The compose form instead follows
 * `src/content/MyContent.tsx`'s flat `useState` + `Outcome` shape, since that is this
 * codebase's convention for a page that writes rather than only reads.
 *
 * Bodies and comments render as plain text (`white-space: pre-wrap` in CSS, plain string
 * interpolation in JSX) -- there is no markdown renderer and no `dangerouslySetInnerHTML`
 * anywhere in this codebase, and the server's own seam (`discussions/forum.ts`) declares
 * the same property on its side, so nothing crossing either boundary is ever markup.
 */
import { useState } from "react";
import {
  type DiscussionListData,
  type DiscussionThreadData,
} from "../play/identity";

type Stage =
  | { readonly kind: "unavailable" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "not-configured" }
  | { readonly kind: "not-found" }
  | { readonly kind: "list"; readonly data: DiscussionListData }
  | { readonly kind: "thread"; readonly data: DiscussionThreadData };

interface Outcome {
  readonly tone: "ok" | "error";
  readonly error?: unknown;
}

const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 4000;

export function Discussions({
  apiUrl,
  threadId,
}: {
  readonly apiUrl?: string;
  readonly threadId?: string;
}) {
  const { t } = useTranslation("community");

  const { identity, loading: identityLoading, refreshToken } = useAccount();

  const client = useQueryClient();
  const queryKey = [
    "private",
    apiUrl,
    identity.playerId,
    refreshToken,
    "discussions",
    threadId ?? "list",
  ];
  const query = useQuery<DiscussionListData | DiscussionThreadData>({
    queryKey,
    queryFn: ({ signal }) =>
      threadId
        ? getDiscussion(apiUrl, threadId, signal)
        : getDiscussions(apiUrl, undefined, signal),
    enabled: Boolean(apiUrl) && !identityLoading,
  });
  const error = query.error;
  const stage: Stage = !apiUrl
    ? { kind: "unavailable" }
    : query.isPending
      ? { kind: "loading" }
      : error instanceof ApiError && error.status === 404
        ? { kind: "not-found" }
        : error instanceof ApiError && error.code === "not_configured"
          ? { kind: "not-configured" }
          : query.isError
            ? { kind: "failed" }
            : threadId
              ? { kind: "thread", data: query.data as DiscussionThreadData }
              : { kind: "list", data: query.data as DiscussionListData };

  const online = useOnline();
  const [paginationError, setPaginationError] = useState<unknown>();
  const [loadingMore, setLoadingMore] = useState(false);

  async function handleLoadMore(): Promise<void> {
    if (stage.kind !== "list" || !stage.data.nextCursor || !apiUrl) return;
    setLoadingMore(true);
    setPaginationError(undefined);
    try {
      const body = await getDiscussions(apiUrl, stage.data.nextCursor);
      // Cancelled/removed account queries must not be recreated by late pagination.
      if (client.getQueryState(queryKey))
        client.setQueryData<DiscussionListData>(queryKey, (current) =>
          current
            ? { ...body, threads: [...current.threads, ...body.threads] }
            : current,
        );
    } catch (error) {
      setPaginationError(error);
    } finally {
      setLoadingMore(false);
    }
  }

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [composeOutcome, setComposeOutcome] = useState<Outcome>();

  async function handlePost(): Promise<void> {
    setPosting(true);
    setComposeOutcome(undefined);
    try {
      await postDiscussion(apiUrl, title, body);
      setTitle("");
      setBody("");
      setComposeOutcome({ tone: "ok" });
      await client.invalidateQueries({ queryKey });
    } catch (error) {
      setComposeOutcome({
        tone: "error",
        error,
      });
    } finally {
      setPosting(false);
    }
  }

  return (
    <>
      <section
        className="feature-page archive discussions"
        aria-labelledby="discussions-title"
      >
        <div className="archive-heading">
          <p className="eyebrow">{t("channelEyebrow")}</p>
          <h1 id="discussions-title">
            {threadId ? t("thread") : t("channel")}
          </h1>
          {!threadId && <p>{t("channelIntro")}</p>}
          {threadId && (
            <p>
              <Link to="/discussions">{t("backChannel")}</Link>
            </p>
          )}

          {stage.kind === "unavailable" && (
            <p className="profile-unavailable">{t("channelUnavailable")}</p>
          )}
          {stage.kind === "not-configured" && (
            <p className="profile-unavailable">{t("channelNotConfigured")}</p>
          )}
          {stage.kind === "loading" && (
            <p className="profile-unavailable" role="status">
              {t("loading")}
            </p>
          )}
          {stage.kind === "failed" && (
            <div role="alert">
              <p>{t("channelFailed")}</p>
              <Button onClick={() => void query.refetch()}>
                {t("common:retry")}
              </Button>
            </div>
          )}
          {stage.kind === "not-found" && (
            <p className="profile-unavailable">{t("threadMissing")}</p>
          )}
        </div>

        {!online && <ResourceState state="offline" />}
        {paginationError !== undefined && (
          <ResourceState state="error" error={paginationError} />
        )}
        {stage.kind === "list" && <ThreadList data={stage.data} />}
        {stage.kind === "list" && stage.data.nextCursor && (
          <p>
            <button
              type="button"
              onClick={() => void handleLoadMore()}
              disabled={loadingMore || !online}
            >
              {loadingMore ? t("loading") : t("loadMore")}
            </button>
          </p>
        )}
        {stage.kind === "thread" && <ThreadDetail data={stage.data} />}

        {!threadId && stage.kind === "list" && (
          <section className="discussions-compose">
            <h2 className="admin-heading">{t("compose")}</h2>
            {!identityLoading && identity.kind !== "member" && (
              <p className="profile-unavailable">{t("signInPost")}</p>
            )}
            {identity.kind === "member" && stage.data.canPost && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void handlePost();
                }}
              >
                <div className="admin-form-row">
                  <input
                    type="text"
                    aria-label={t("subject")}
                    placeholder={t("subject")}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={MAX_TITLE_LENGTH}
                  />
                </div>
                <textarea
                  className="admin-paste"
                  rows={6}
                  aria-label={t("body")}
                  placeholder={t("body")}
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  maxLength={MAX_BODY_LENGTH}
                />
                <button
                  type="submit"
                  disabled={!online || posting || !title.trim() || !body.trim()}
                >
                  {posting ? t("posting") : t("post")}
                </button>
                {composeOutcome && (
                  <div
                    className={
                      composeOutcome.tone === "error"
                        ? "admin-error"
                        : "admin-notice"
                    }
                    role={composeOutcome.tone === "error" ? "alert" : "status"}
                  >
                    {composeOutcome.tone === "ok" ? (
                      t("posted")
                    ) : (
                      <ResourceState
                        state="error"
                        error={composeOutcome.error}
                      />
                    )}
                  </div>
                )}
              </form>
            )}
          </section>
        )}
      </section>
    </>
  );
}

function ThreadList({ data }: { readonly data: DiscussionListData }) {
  const { t } = useTranslation("community");
  const { date } = useLocale();
  if (data.threads.length === 0) {
    return <p className="profile-unavailable">{t("noThreads")}</p>;
  }
  return (
    <ul className="discussions-list">
      {data.threads.map((thread) => (
        <li key={thread.id} className="discussions-list-item">
          <Link to={`/discussions/${thread.id}`}>{thread.title}</Link>
          <p className="discussions-excerpt">{thread.excerpt}</p>
          <p className="discussions-meta">
            {thread.authorName} &mdash; {date(thread.updatedAt)}
            &mdash; {t("replyCount", { count: thread.commentCount })}
          </p>
        </li>
      ))}
    </ul>
  );
}

function ThreadDetail({ data }: { readonly data: DiscussionThreadData }) {
  const { t } = useTranslation("community");
  const { date } = useLocale();
  return (
    <article className="discussions-thread">
      <h2>{data.thread.title}</h2>
      <p className="discussions-meta">
        {data.thread.authorName} &mdash; {date(data.thread.createdAt)}
      </p>
      <p className="discussions-body">{data.body}</p>
      <p>
        <a href={data.thread.url}>{t("viewForum", { forum: data.forum })}</a>
      </p>
      <h3>{t("replies")}</h3>
      {data.comments.length === 0 ? (
        <p className="profile-unavailable">{t("noReplies")}</p>
      ) : (
        <ul className="discussions-comments">
          {data.comments.map((comment) => (
            <li key={comment.id} className="discussions-comment">
              <p className="discussions-meta">
                {comment.authorName} &mdash; {date(comment.createdAt)}
              </p>
              <p className="discussions-body">{comment.body}</p>
            </li>
          ))}
        </ul>
      )}
      {data.moreComments && (
        <p>
          <a href={data.thread.url}>{t("restForum", { forum: data.forum })}</a>
        </p>
      )}
    </article>
  );
}
