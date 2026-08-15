/**
 * `/discussions` and `/discussions/<id>`, reached via `main.tsx`'s routing -- a
 * purpose-built forum page over this repository's GitHub Discussions
 * (`server/src/routes/discussions.ts`), mirroring `src/ranking/Ranking.tsx`'s shape:
 * same `apiUrl`-as-prop convention (read once by `main.tsx`, never `import.meta.env`
 * here), same theme block, same `Header` nav item. The compose form instead follows
 * `src/content/MyContent.tsx`'s flat `useState` + `Outcome` shape, since that is this
 * codebase's convention for a page that writes rather than only reads.
 *
 * Bodies and comments render as plain text (`white-space: pre-wrap` in CSS, plain string
 * interpolation in JSX) -- there is no markdown renderer and no `dangerouslySetInnerHTML`
 * anywhere in this codebase, and the server's own seam (`discussions/forum.ts`) declares
 * the same property on its side, so nothing crossing either boundary is ever markup.
 */
import { useEffect, useState } from "react";
import { Header } from "../Header";
import { AccountPanel } from "../play/AccountPanel";
import {
  consumeAuthError,
  useAdminAccess,
  useIdentity,
  type DiscussionListData,
  type DiscussionThreadData,
} from "../play/identity";
import { formatTimestamp } from "../format";
import {
  applyTheme,
  DEFAULT_THEME,
  readStoredTheme,
  storeTheme,
  type ThemeId,
} from "../theme";

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
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);
  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);
  function changeTheme(id: ThemeId): void {
    setTheme(id);
    applyTheme(id);
    storeTheme(id);
  }

  const [identityRefreshToken, setIdentityRefreshToken] = useState(0);
  const { identity, loading: identityLoading } = useIdentity(
    apiUrl,
    identityRefreshToken,
  );
  const { isAdmin } = useAdminAccess(apiUrl, identity.playerId);
  const [authError] = useState(() => consumeAuthError());

  const [refreshToken, setRefreshToken] = useState(0);
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

    const url = threadId
      ? `${apiUrl}/api/discussions/${encodeURIComponent(threadId)}`
      : `${apiUrl}/api/discussions`;

    fetch(url, { credentials: "include" })
      .then(async (response) => {
        if (response.status === 404) {
          if (!cancelled) setStage({ kind: "not-found" });
          return;
        }
        if (response.status === 503) {
          const body = (await response.json().catch(() => undefined)) as
            { error?: { code?: string } } | undefined;
          if (!cancelled) {
            setStage(
              body?.error?.code === "not_configured"
                ? { kind: "not-configured" }
                : { kind: "failed" },
            );
          }
          return;
        }
        if (!response.ok) {
          if (!cancelled) setStage({ kind: "failed" });
          return;
        }
        const body = await response.json();
        if (cancelled) return;
        setStage(
          threadId
            ? { kind: "thread", data: body as DiscussionThreadData }
            : { kind: "list", data: body as DiscussionListData },
        );
      })
      .catch(() => {
        if (!cancelled) setStage({ kind: "failed" });
      });

    return () => {
      cancelled = true;
    };
    // `refreshToken` bumps after a successful post, so the list picks up the new thread
    // without a full page reload. The compose form's own gate is `identity.kind`, read
    // directly (below), not the response's `canPost` field, so a sign-in/out round trip
    // does not need to be in this dependency list.
  }, [apiUrl, threadId, refreshToken]);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [composeOutcome, setComposeOutcome] = useState<Outcome>();

  async function handlePost(): Promise<void> {
    setPosting(true);
    setComposeOutcome(undefined);
    try {
      const response = await fetch(`${apiUrl}/api/discussions`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body }),
      });
      const json = (await response.json().catch(() => undefined)) as
        { error?: { code?: string } } | undefined;
      if (!response.ok) {
        throw new Error(
          json?.error?.code
            ? `${response.status} (${json.error.code})`
            : `${response.status}`,
        );
      }
      setTitle("");
      setBody("");
      setComposeOutcome({ tone: "ok", text: "Posted." });
      setRefreshToken((t) => t + 1);
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
    <main className="play-main">
      <Header current="discussions" theme={theme} onThemeChange={changeTheme}>
        {apiUrl && (
          <AccountPanel
            apiUrl={apiUrl}
            identity={identity}
            loading={identityLoading}
            authError={authError}
            onChanged={() => setIdentityRefreshToken((t) => t + 1)}
            isAdmin={isAdmin}
            profileAvailable={true}
          />
        )}
      </Header>
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
              <a href="/discussions">&larr; Back to the channel</a>
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
    </main>
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
          <a href={`/discussions/${thread.id}`}>{thread.title}</a>
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
