/**
 * `DiscussionForum` over GitHub Discussions -- the one implementation. Reads **no**
 * environment: the owner/repo, category, and token are constructor parameters, exactly as
 * `identity/oidc.ts`'s issuer/client id/secret are (see that file's own header). A second
 * forum backend is a second file behind `forum.ts`, not a second design.
 *
 * Hand-rolled GraphQL over `fetch` rather than a client library or `octokit` -- neither is
 * a dependency of `server/package.json`, and `CLAUDE.md` gates a new one on a decision-log
 * entry this repo has not written. `campaigns/source.ts` already hand-rolls its own
 * timeout/retry over plain `fetch`; the transport helpers below copy that shape.
 */
import {
  type CreateThreadInput,
  type DiscussionComment,
  type DiscussionForum,
  DiscussionForumError,
  type DiscussionForumFailure,
  type DiscussionThread,
  type DiscussionThreadDetail,
  type DiscussionThreadPage,
} from "./forum.js";

type FetchImpl = (url: string | URL, init: RequestInit) => Promise<Response>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GitHub's plain-text rendering of a discussion body (`bodyText`) truncated for a list
 *  view -- never `body` (raw markdown, which this codebase has no renderer for) and never
 *  `bodyHTML` (which would require `dangerouslySetInnerHTML`, with no precedent in `src/`
 *  and no reason to start one). See `forum.ts`'s header on why the seam is plain text. */
function excerptOf(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (trimmed.length <= 280) return trimmed;
  const cut = trimmed.slice(0, 280);
  const lastSpace = cut.lastIndexOf(" ");
  const boundary = lastSpace > 40 ? lastSpace : 280;
  return `${cut.slice(0, boundary).trimEnd()}…`;
}

/**
 * Marks a transport failure as safe to retry -- a distinct wrapper rather than a flag on
 * `DiscussionForumError` itself, so that error type stays exactly what `forum.ts` declares
 * it to be and retryability (an implementation detail of this one adapter) never leaks
 * across the seam. Thrown only for a 5xx response or a transport-level rejection (including
 * the abort `AbortSignal.timeout` raises); everything else -- 401/403/429, a GraphQL
 * `errors[]` entry, a non-5xx non-2xx status -- is not retried, because retrying an
 * authorization failure or a client error only spends more of the same rate-limit budget
 * for the same answer. */
class RetryableFailure extends Error {
  readonly forumError: DiscussionForumError;

  constructor(forumError: DiscussionForumError) {
    super(forumError.message);
    this.forumError = forumError;
  }
}

interface GraphQLErrorEntry {
  readonly message: string;
  readonly type?: string;
}

interface GraphQLResponse<T> {
  readonly data?: T;
  readonly errors?: readonly GraphQLErrorEntry[];
}

function classifyGraphQLErrorType(
  type: string | undefined,
): DiscussionForumFailure {
  switch (type) {
    case "NOT_FOUND":
      return "not_found";
    case "FORBIDDEN":
    case "INSUFFICIENT_SCOPES":
      return "unauthorized";
    case "RATE_LIMITED":
      return "rate_limited";
    default:
      return "unavailable";
  }
}

interface TransportContext {
  readonly endpoint: string;
  readonly token: string;
  readonly fetchImpl: FetchImpl;
  readonly timeoutMs: number;
}

/** One HTTP round trip -- no retry here, `postWithRetry` below owns that. Every failure
 *  becomes either a `DiscussionForumError` (final) or a `RetryableFailure` wrapping one
 *  (worth another attempt); nothing else escapes this function. */
async function postOnce<T>(
  ctx: TransportContext,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await ctx.fetchImpl(ctx.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.token}`,
        "content-type": "application/json",
        accept: "application/vnd.github+json",
        "user-agent": "SubZeroDev.Adventures",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
  } catch (error) {
    // A transport-level rejection -- including the abort `AbortSignal.timeout` raises --
    // never carries request headers or the token in its message, so it is safe to fold in
    // whole via `cause`.
    throw new RetryableFailure(
      new DiscussionForumError(
        "unavailable",
        `discussion forum request failed: ${String(error)}`,
        { cause: error },
      ),
    );
  }

  // Folded into every thrown message below, never into a response body a player sees
  // (`routes/discussions.ts` logs and re-codes every `DiscussionForumError`) -- this is the
  // one thread an operator has to debug a misconfigured token or repository with.
  const requestId = response.headers.get("x-github-request-id");
  const detail = requestId ? ` (request ${requestId})` : "";

  if (!response.ok) {
    if (response.status === 401) {
      throw new DiscussionForumError(
        "unauthorized",
        `discussion forum returned 401${detail}`,
      );
    }
    if (response.status === 403) {
      // GitHub reports both its primary and secondary (abuse-detection) rate limits as a
      // 403 on the GraphQL endpoint, not a 429 -- distinguished from an ordinary
      // authorization 403 only by these headers.
      const remaining = response.headers.get("x-ratelimit-remaining");
      const retryAfter = response.headers.get("retry-after");
      if (remaining === "0" || retryAfter) {
        throw new DiscussionForumError(
          "rate_limited",
          `discussion forum rate limit exceeded${detail}`,
        );
      }
      throw new DiscussionForumError(
        "unauthorized",
        `discussion forum returned 403${detail}`,
      );
    }
    if (response.status === 429) {
      throw new DiscussionForumError(
        "rate_limited",
        `discussion forum rate limit exceeded${detail}`,
      );
    }
    if (response.status >= 500) {
      throw new RetryableFailure(
        new DiscussionForumError(
          "unavailable",
          `discussion forum returned ${response.status}${detail}`,
        ),
      );
    }
    throw new DiscussionForumError(
      "unavailable",
      `discussion forum returned ${response.status}${detail}`,
    );
  }

  const body = (await response.json()) as GraphQLResponse<T>;
  // GraphQL answers 200 even when it failed -- the failure lives in `errors`, optionally
  // alongside a partially-populated `data`. Treated as total failure, never a partial
  // success: the same fail-closed reflex `campaigns/source.ts` documents for a partial
  // fetch ("a shorter catalog is not invalid, it is merely wrong").
  if (body.errors && body.errors.length > 0) {
    const first = body.errors[0]!;
    throw new DiscussionForumError(
      classifyGraphQLErrorType(first.type),
      `discussion forum GraphQL error: ${first.message}${detail}`,
    );
  }
  if (body.data === undefined) {
    throw new DiscussionForumError(
      "unavailable",
      `discussion forum returned no data${detail}`,
    );
  }
  return body.data;
}

async function postWithRetry<T>(
  ctx: TransportContext,
  query: string,
  variables: Record<string, unknown>,
  retries: number,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await postOnce<T>(ctx, query, variables);
    } catch (error) {
      if (!(error instanceof RetryableFailure) || attempt >= retries) {
        throw error instanceof RetryableFailure ? error.forumError : error;
      }
      await sleep(200 * 2 ** attempt);
    }
  }
}

const IDS_QUERY = `
  query ForumIds($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id
      isPrivate
      discussionCategories(first: 25) {
        nodes { id name slug }
      }
    }
  }
`;

const LIST_QUERY = `
  query ForumThreads($owner: String!, $name: String!, $categoryId: ID!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      discussions(
        first: $first
        after: $after
        categoryId: $categoryId
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number title bodyText url createdAt updatedAt
          author { login }
          comments { totalCount }
        }
      }
    }
  }
`;

const THREAD_QUERY = `
  query ForumThread($owner: String!, $name: String!, $number: Int!, $comments: Int!) {
    repository(owner: $owner, name: $name) {
      discussion(number: $number) {
        number title bodyText url createdAt updatedAt
        category { id }
        author { login }
        comments(first: $comments) {
          totalCount
          pageInfo { hasNextPage }
          nodes { id bodyText url createdAt author { login } }
        }
      }
    }
  }
`;

const CREATE_MUTATION = `
  mutation CreateForumThread($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
    createDiscussion(input: {
      repositoryId: $repositoryId
      categoryId: $categoryId
      title: $title
      body: $body
    }) {
      discussion {
        number title bodyText url createdAt updatedAt
        author { login }
        comments { totalCount }
      }
    }
  }
`;

interface GraphQLDiscussionNode {
  readonly number: number;
  readonly title: string;
  readonly bodyText: string;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly author: { readonly login: string } | null;
  readonly comments: { readonly totalCount: number };
}

interface IdsResponse {
  readonly repository: {
    readonly id: string;
    readonly isPrivate: boolean;
    readonly discussionCategories: {
      readonly nodes: readonly {
        readonly id: string;
        readonly name: string;
        readonly slug: string;
      }[];
    };
  } | null;
}

interface ListResponse {
  readonly repository: {
    readonly discussions: {
      readonly pageInfo: {
        readonly hasNextPage: boolean;
        readonly endCursor: string | null;
      };
      readonly nodes: readonly (GraphQLDiscussionNode | null)[];
    };
  } | null;
}

interface ThreadResponse {
  readonly repository: {
    readonly discussion:
      | (GraphQLDiscussionNode & {
          readonly category: { readonly id: string } | null;
          readonly comments: {
            readonly totalCount: number;
            readonly pageInfo: { readonly hasNextPage: boolean };
            readonly nodes: readonly ({
              readonly id: string;
              readonly bodyText: string;
              readonly url: string;
              readonly createdAt: string;
              readonly author: { readonly login: string } | null;
            } | null)[];
          };
        })
      | null;
  } | null;
}

interface CreateResponse {
  readonly createDiscussion: {
    readonly discussion: GraphQLDiscussionNode;
  };
}

function toThread(node: GraphQLDiscussionNode): DiscussionThread {
  return {
    id: String(node.number),
    title: node.title,
    excerpt: excerptOf(node.bodyText),
    authorLogin: node.author?.login ?? null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    commentCount: node.comments.totalCount,
    url: node.url,
  };
}

interface ResolvedIds {
  readonly repositoryId: string;
  readonly categoryId: string;
}

async function fetchIds(
  ctx: TransportContext,
  owner: string,
  repo: string,
  categorySlug: string,
  retries: number,
): Promise<ResolvedIds> {
  const data = await postWithRetry<IdsResponse>(
    ctx,
    IDS_QUERY,
    { owner, name: repo },
    retries,
  );
  if (!data.repository) {
    throw new DiscussionForumError(
      "not_found",
      `discussion forum: repository ${owner}/${repo} not found, or the configured token cannot see it`,
    );
  }
  // The read routes are public and unauthenticated -- pointing this at a private
  // repository would republish private content with no gate at all. Checked here, on a
  // query already being made once per process, rather than left as a documentation-only
  // warning.
  if (data.repository.isPrivate) {
    throw new DiscussionForumError(
      "unauthorized",
      `discussion forum: ${owner}/${repo} is private -- refusing to serve a public route from a private repository`,
    );
  }
  const categories = data.repository.discussionCategories.nodes;
  const normalized = categorySlug.trim().toLowerCase();
  const match =
    categories.find((c) => c.slug.toLowerCase() === normalized) ??
    categories.find((c) => c.name.toLowerCase() === normalized);
  if (!match) {
    const available =
      categories.map((c) => c.slug).join(", ") ||
      "(no discussion categories found)";
    throw new DiscussionForumError(
      "unavailable",
      `discussion forum: category "${categorySlug}" not found in ${owner}/${repo} -- available categories: ${available}`,
    );
  }
  return { repositoryId: data.repository.id, categoryId: match.id };
}

export function createGitHubDiscussionForum(options: {
  readonly owner: string;
  readonly repo: string;
  readonly categorySlug: string;
  readonly token: string;
  /** Default `https://api.github.com/graphql`. Overridable so a test can point this at a
   *  loopback `node:http` server -- the server test suite never stubs global `fetch`
   *  (`campaigns/source.test.ts`'s header). */
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly fetchImpl?: FetchImpl;
}): DiscussionForum {
  const owner = options.owner;
  const repo = options.repo;
  const categorySlug = options.categorySlug;
  const ctx: TransportContext = {
    endpoint: options.endpoint ?? "https://api.github.com/graphql",
    token: options.token,
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? 10_000,
  };
  const retries = options.retries ?? 2;

  // Lazy and memoized: construction does no I/O, so an unreachable network at boot cannot
  // keep the server from starting (discussions are optional; identity providers, which do
  // await discovery at construction, are not). A failed resolution is not cached, so the
  // next call retries it; a success is cached for the life of the process, matching
  // `content-cell.ts`'s publish-only-on-success shape for its own in-flight coalescing.
  let idsPromise: Promise<ResolvedIds> | undefined;
  function resolveIds(): Promise<ResolvedIds> {
    if (!idsPromise) {
      idsPromise = fetchIds(ctx, owner, repo, categorySlug, retries).catch(
        (error: unknown) => {
          idsPromise = undefined;
          throw error;
        },
      );
    }
    return idsPromise;
  }

  return {
    name: "github",

    async listThreads(listOptions) {
      const { categoryId } = await resolveIds();
      const first = Math.min(Math.max(listOptions?.limit ?? 20, 1), 50);
      const data = await postWithRetry<ListResponse>(
        ctx,
        LIST_QUERY,
        {
          owner,
          name: repo,
          categoryId,
          first,
          after: listOptions?.cursor ?? null,
        },
        retries,
      );
      if (!data.repository) {
        throw new DiscussionForumError(
          "not_found",
          `discussion forum: repository ${owner}/${repo} not found`,
        );
      }
      const nodes = data.repository.discussions.nodes.filter(
        (node): node is GraphQLDiscussionNode => node !== null,
      );
      const page = data.repository.discussions.pageInfo;
      const result: DiscussionThreadPage = {
        threads: nodes.map(toThread),
        ...(page.hasNextPage && page.endCursor
          ? { nextCursor: page.endCursor }
          : {}),
      };
      return result;
    },

    async getThread(id) {
      const { categoryId } = await resolveIds();
      // GitHub discussion numbers are positive integers; a non-canonical string (leading
      // zeros, a sign, letters) cannot name a real one, so it is "not found" rather than a
      // request worth making.
      const number = Number.parseInt(id, 10);
      if (!Number.isInteger(number) || number <= 0 || String(number) !== id) {
        return undefined;
      }
      let data: ThreadResponse;
      try {
        data = await postWithRetry<ThreadResponse>(
          ctx,
          THREAD_QUERY,
          { owner, name: repo, number, comments: 50 },
          retries,
        );
      } catch (error) {
        // A `NOT_FOUND` GraphQL error here means "no such discussion number" -- the same
        // outcome as the repository query resolving `discussion: null` below, so it folds
        // into the same `undefined`, per `forum.ts`'s "not found" contract for this
        // method. Every other failure still throws.
        if (
          error instanceof DiscussionForumError &&
          error.reason === "not_found"
        ) {
          return undefined;
        }
        throw error;
      }
      const discussion = data.repository?.discussion;
      if (!discussion) return undefined;
      // The read route is public -- a discussion outside the configured category must
      // never be reachable by number, or this becomes an unfiltered read of every
      // discussion in the repository regardless of what `resolveIds` found.
      if (discussion.category?.id !== categoryId) return undefined;
      const comments: DiscussionComment[] = discussion.comments.nodes
        .filter((node): node is NonNullable<typeof node> => node !== null)
        .map((node) => ({
          id: node.id,
          body: node.bodyText,
          authorLogin: node.author?.login ?? null,
          createdAt: node.createdAt,
          url: node.url,
        }));
      const detail: DiscussionThreadDetail = {
        thread: toThread(discussion),
        body: discussion.bodyText,
        comments,
        moreComments: discussion.comments.pageInfo.hasNextPage,
      };
      return detail;
    },

    async createThread(input: CreateThreadInput) {
      const { repositoryId, categoryId } = await resolveIds();
      const body = `${input.body}\n\n> Posted from SubZeroDev.Adventures by ${input.authorLabel}.`;
      const data = await postWithRetry<CreateResponse>(
        ctx,
        CREATE_MUTATION,
        { repositoryId, categoryId, title: input.title, body },
        // Never retried: `createDiscussion` is not idempotent and GraphQL offers no
        // idempotency key, so retrying a mutation whose first attempt actually succeeded
        // but whose response was lost would publish a duplicate public post. Reads are
        // safe to retry; this one is not.
        0,
      );
      return toThread(data.createDiscussion.discussion);
    },
  };
}
