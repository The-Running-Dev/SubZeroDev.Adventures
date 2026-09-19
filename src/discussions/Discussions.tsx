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
import { formatTimestamp } from "../format";

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
  readonly text: string;
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

  const [loadingMore, setLoadingMore] = useState(false);

  async function handleLoadMore(): Promise<void> {
    if (stage.kind !== "list" || !stage.data.nextCursor || !apiUrl) return;
    setLoadingMore(true);
    try {
      const body = await getDiscussions(apiUrl, stage.data.nextCursor);
      // Cancelled/removed account queries must not be recreated by late pagination.
      if (client.getQueryState(queryKey))
        client.setQueryData<DiscussionListData>(queryKey, (current) =>
          current
            ? { ...body, threads: [...current.threads, ...body.threads] }
            : current,
        );
    } catch {
      // The existing list remains usable and its load-more action remains retryable.
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
      setComposeOutcome({ tone: "ok", text: "Posted." });
      await client.invalidateQueries({ queryKey });
    } catch (error) {
      setComposeOutcome({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPosting(false);
    }
  }

  return (
    <>
      <section
        className="archive discussions"
        aria-labelledby="discussions-title"
      >
        <div className="archive-heading">
          <p className="eyebrow">SUBZERO STORY SYSTEM // OPERATOR CHANNEL</p>
          <h1 id="discussions-title">
            {threadId ? "Thread" : "Operator channel"}
          </h1>
          {!threadId && (
            <p>
              Talk shop with other operators. Threads live on the project's own
              forum -- posting uses your SubZeroDev session, not a second
              sign-in.
            </p>
          )}
          {threadId && (
            <p>
              <Link to="/discussions">&larr; Back to the channel</Link>
            </p>
          )}

          {stage.kind === "unavailable" && (
            <p className="profile-unavailable">
              Discussions aren't available on this build.
            </p>
          )}
          {stage.kind === "not-configured" && (
            <p className="profile-unavailable">
              Discussions aren't set up on this deployment yet.
            </p>
          )}
          {stage.kind === "loading" && (
            <p className="profile-unavailable" role="status">
              Loading…
            </p>
          )}
          {stage.kind === "failed" && (
            <p className="profile-unavailable">
              The forum isn't reachable right now. Try again shortly.
            </p>
          )}
          {stage.kind === "not-found" && (
            <p className="profile-unavailable">No such thread.</p>
          )}
        </div>

        {stage.kind === "list" && <ThreadList data={stage.data} />}
        {stage.kind === "list" && stage.data.nextCursor && (
          <p>
            <button
              type="button"
              onClick={() => void handleLoadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </p>
        )}
        {stage.kind === "thread" && <ThreadDetail data={stage.data} />}

        {!threadId && stage.kind === "list" && (
          <section className="discussions-compose">
            <h2 className="admin-heading">Start a thread</h2>
            {!identityLoading && identity.kind !== "member" && (
              <p className="profile-unavailable">Sign in to start a thread.</p>
            )}
            {identity.kind === "member" && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void handlePost();
                }}
              >
                <div className="admin-form-row">
                  <input
                    type="text"
                    placeholder="Title"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={MAX_TITLE_LENGTH}
                  />
                </div>
                <textarea
                  className="admin-paste"
                  rows={6}
                  placeholder="What's on your mind?"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  maxLength={MAX_BODY_LENGTH}
                />
                <button
                  type="submit"
                  disabled={posting || !title.trim() || !body.trim()}
                >
                  {posting ? "Posting…" : "Post"}
                </button>
                {composeOutcome && (
                  <p
                    className={
                      composeOutcome.tone === "error"
                        ? "admin-error"
                        : "admin-notice"
                    }
                    role={composeOutcome.tone === "error" ? "alert" : "status"}
                  >
                    {composeOutcome.text}
                  </p>
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
  if (data.threads.length === 0) {
    return <p className="profile-unavailable">No threads yet. Be the first.</p>;
  }
  return (
    <ul className="discussions-list">
      {data.threads.map((thread) => (
        <li key={thread.id} className="discussions-list-item">
          <Link to={`/discussions/${thread.id}`}>{thread.title}</Link>
          <p className="discussions-excerpt">{thread.excerpt}</p>
          <p className="discussions-meta">
            {thread.authorName} &mdash; {formatTimestamp(thread.updatedAt)}
            &mdash; {thread.commentCount}{" "}
            {thread.commentCount === 1 ? "reply" : "replies"}
          </p>
        </li>
      ))}
    </ul>
  );
}

function ThreadDetail({ data }: { readonly data: DiscussionThreadData }) {
  return (
    <article className="discussions-thread">
      <h2>{data.thread.title}</h2>
      <p className="discussions-meta">
        {data.thread.authorName} &mdash;{" "}
        {formatTimestamp(data.thread.createdAt)}
      </p>
      <p className="discussions-body">{data.body}</p>
      <p>
        <a href={data.thread.url}>View on {data.forum}</a>
      </p>
      <h3>Replies</h3>
      {data.comments.length === 0 ? (
        <p className="profile-unavailable">No replies yet.</p>
      ) : (
        <ul className="discussions-comments">
          {data.comments.map((comment) => (
            <li key={comment.id} className="discussions-comment">
              <p className="discussions-meta">
                {comment.authorName} &mdash;{" "}
                {formatTimestamp(comment.createdAt)}
              </p>
              <p className="discussions-body">{comment.body}</p>
            </li>
          ))}
        </ul>
      )}
      {data.moreComments && (
        <p>
          <a href={data.thread.url}>See the rest on {data.forum}.</a>
        </p>
      )}
    </article>
  );
}
