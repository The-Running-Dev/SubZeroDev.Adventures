/**
 * `createGitHubDiscussionForum` against a real local HTTP server standing in for the
 * GraphQL endpoint -- no mocking of `fetch` itself, matching `campaigns/source.test.ts`'s
 * posture (that file's header explains why). No `DATABASE_URL` needed; this never touches
 * Postgres.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createGitHubDiscussionForum } from "./github.js";
import { DiscussionForumError } from "./forum.js";

interface GraphQLRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly query: string;
  readonly variables: Record<string, unknown>;
}

interface Handler {
  (request: GraphQLRequest): {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
    delayMs?: number;
  };
}

function operationNameOf(query: string): string {
  const match = /^\s*(?:query|mutation)\s+(\w+)/.exec(query);
  return match?.[1] ?? "(anonymous)";
}

function startGraphQLServer(
  handler: Handler,
): Promise<{ server: Server; url: string; requests: GraphQLRequest[] }> {
  const requests: GraphQLRequest[] = [];
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          query: string;
          variables: Record<string, unknown>;
        };
        const gqlRequest: GraphQLRequest = {
          headers: request.headers,
          query: parsed.query,
          variables: parsed.variables,
        };
        requests.push(gqlRequest);
        const { status, body, headers, delayMs } = handler(gqlRequest);
        const send = () => {
          response.writeHead(status, {
            "content-type": "application/json",
            ...headers,
          });
          response.end(body === undefined ? "" : JSON.stringify(body));
        };
        if (delayMs) setTimeout(send, delayMs);
        else send();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("expected a bound TCP address");
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/`,
        requests,
      });
    });
  });
}

const idsData = {
  repository: {
    id: "R_repo",
    isPrivate: false,
    discussionCategories: {
      nodes: [
        { id: "C_general", name: "General", slug: "general" },
        { id: "C_ideas", name: "Ideas", slug: "ideas" },
      ],
    },
  },
};

function discussionNode(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    number: 42,
    title: "Best disk in the shelf?",
    bodyText: "What is everyone's favourite campaign right now?",
    url: "https://github.com/o/r/discussions/42",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    author: { login: "ripcord" },
    comments: { totalCount: 3 },
    ...overrides,
  };
}

describe("createGitHubDiscussionForum", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  });

  function forumAgainst(
    handler: Handler,
    options: { readonly timeoutMs?: number; readonly retries?: number } = {},
  ) {
    return startGraphQLServer(handler).then(({ server: s, url, requests }) => {
      server = s;
      const forum = createGitHubDiscussionForum({
        owner: "the-running-dev",
        repo: "SubZeroDev.Adventures",
        categorySlug: "general",
        token: "secret-token",
        endpoint: url,
        timeoutMs: options.timeoutMs ?? 2000,
        retries: options.retries ?? 2,
      });
      return { forum, requests };
    });
  }

  it("sends a bearer-token POST naming the GraphQL operation", async () => {
    const { forum, requests } = await forumAgainst((request) => {
      if (operationNameOf(request.query) === "ForumIds") {
        return { status: 200, body: { data: idsData } };
      }
      return {
        status: 200,
        body: {
          data: {
            repository: {
              discussions: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [discussionNode()],
              },
            },
          },
        },
      };
    });

    await forum.listThreads();

    expect(requests).toHaveLength(2);
    expect(requests[0]!.headers.authorization).toBe("Bearer secret-token");
    expect(operationNameOf(requests[1]!.query)).toBe("ForumThreads");
  });

  it("resolves repository/category ids once and reuses them across calls", async () => {
    let idsCalls = 0;
    const { forum, requests } = await forumAgainst((request) => {
      const op = operationNameOf(request.query);
      if (op === "ForumIds") {
        idsCalls++;
        return { status: 200, body: { data: idsData } };
      }
      if (op === "ForumThreads") {
        return {
          status: 200,
          body: {
            data: {
              repository: {
                discussions: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [discussionNode()],
                },
              },
            },
          },
        };
      }
      return {
        status: 200,
        body: {
          data: { createDiscussion: { discussion: discussionNode() } },
        },
      };
    });

    await forum.listThreads();
    await forum.createThread({ title: "t", body: "b", authorLabel: "Ada" });

    expect(idsCalls).toBe(1);
    expect(requests).toHaveLength(3);
  });

  it("maps bodyText to the excerpt, truncated at a whitespace boundary", async () => {
    const longBody = `${"word ".repeat(80)}tail`;
    const { forum } = await forumAgainst((request) => {
      if (operationNameOf(request.query) === "ForumIds")
        return { status: 200, body: { data: idsData } };
      return {
        status: 200,
        body: {
          data: {
            repository: {
              discussions: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [discussionNode({ bodyText: longBody })],
              },
            },
          },
        },
      };
    });

    const page = await forum.listThreads();
    expect(page.threads[0]!.excerpt.length).toBeLessThanOrEqual(281);
    expect(page.threads[0]!.excerpt.endsWith("…")).toBe(true);
    expect(longBody).not.toContain(page.threads[0]!.excerpt);
  });

  it("throws unauthorized for a private repository", async () => {
    const { forum } = await forumAgainst(() => ({
      status: 200,
      body: {
        data: { repository: { ...idsData.repository, isPrivate: true } },
      },
    }));

    await expect(forum.listThreads()).rejects.toMatchObject({
      reason: "unauthorized",
    });
  });

  it("throws with the available categories when the configured slug is missing", async () => {
    const { forum } = await forumAgainst(() => ({
      status: 200,
      body: {
        data: {
          repository: {
            ...idsData.repository,
            discussionCategories: {
              nodes: [
                { id: "C_x", name: "Announcements", slug: "announcements" },
              ],
            },
          },
        },
      },
    }));

    await expect(forum.listThreads()).rejects.toThrow(/announcements/);
  });

  it("matches a category slug case-insensitively", async () => {
    server = (
      await startGraphQLServer((request) => {
        if (operationNameOf(request.query) === "ForumIds") {
          return {
            status: 200,
            body: {
              data: {
                repository: {
                  ...idsData.repository,
                  discussionCategories: {
                    nodes: [{ id: "C_g", name: "General", slug: "General" }],
                  },
                },
              },
            },
          };
        }
        return {
          status: 200,
          body: {
            data: {
              repository: {
                discussions: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        };
      })
    ).server;
    const address = server.address();
    const url = `http://127.0.0.1:${(address as { port: number }).port}/`;
    const forum = createGitHubDiscussionForum({
      owner: "o",
      repo: "r",
      categorySlug: "general",
      token: "t",
      endpoint: url,
    });

    await expect(forum.listThreads()).resolves.toMatchObject({ threads: [] });
  });

  it("resolves undefined for a NOT_FOUND GraphQL error on a thread lookup", async () => {
    const { forum } = await forumAgainst((request) => {
      if (operationNameOf(request.query) === "ForumIds")
        return { status: 200, body: { data: idsData } };
      return {
        status: 200,
        body: { errors: [{ message: "Could not resolve", type: "NOT_FOUND" }] },
      };
    });

    await expect(forum.getThread("42")).resolves.toBeUndefined();
  });

  it("throws not_found for a NOT_FOUND GraphQL error on a list", async () => {
    const { forum } = await forumAgainst((request) => {
      if (operationNameOf(request.query) === "ForumIds")
        return { status: 200, body: { data: idsData } };
      return {
        status: 200,
        body: { errors: [{ message: "gone", type: "NOT_FOUND" }] },
      };
    });

    await expect(forum.listThreads()).rejects.toMatchObject({
      reason: "not_found",
    });
  });

  it("maps HTTP 401 to unauthorized", async () => {
    const { forum } = await forumAgainst(() => ({ status: 401, body: {} }));
    await expect(forum.listThreads()).rejects.toMatchObject({
      reason: "unauthorized",
    });
  });

  it("maps HTTP 403 with an exhausted rate limit header to rate_limited", async () => {
    const { forum } = await forumAgainst(() => ({
      status: 403,
      body: {},
      headers: { "x-ratelimit-remaining": "0" },
    }));
    await expect(forum.listThreads()).rejects.toMatchObject({
      reason: "rate_limited",
    });
  });

  it("maps an ordinary HTTP 403 to unauthorized", async () => {
    const { forum } = await forumAgainst(() => ({ status: 403, body: {} }));
    await expect(forum.listThreads()).rejects.toMatchObject({
      reason: "unauthorized",
    });
  });

  it("maps HTTP 429 to rate_limited", async () => {
    const { forum } = await forumAgainst(() => ({ status: 429, body: {} }));
    await expect(forum.listThreads()).rejects.toMatchObject({
      reason: "rate_limited",
    });
  });

  it("retries a read on 5xx and eventually throws unavailable", async () => {
    let calls = 0;
    const { forum } = await forumAgainst(
      (request) => {
        if (operationNameOf(request.query) === "ForumIds")
          return { status: 200, body: { data: idsData } };
        calls++;
        return { status: 502, body: {} };
      },
      { retries: 2 },
    );

    await expect(forum.listThreads()).rejects.toMatchObject({
      reason: "unavailable",
    });
    expect(calls).toBe(3); // 1 initial attempt + 2 retries
  });

  it("never retries createThread, even on a 5xx", async () => {
    let createCalls = 0;
    const { forum } = await forumAgainst((request) => {
      const op = operationNameOf(request.query);
      if (op === "ForumIds") return { status: 200, body: { data: idsData } };
      createCalls++;
      return { status: 502, body: {} };
    });

    await expect(
      forum.createThread({ title: "t", body: "b", authorLabel: "Ada" }),
    ).rejects.toMatchObject({ reason: "unavailable" });
    expect(createCalls).toBe(1);
  });

  it("excludes a discussion outside the configured category", async () => {
    const { forum } = await forumAgainst((request) => {
      if (operationNameOf(request.query) === "ForumIds")
        return { status: 200, body: { data: idsData } };
      return {
        status: 200,
        body: {
          data: {
            repository: {
              discussion: {
                ...discussionNode(),
                category: { id: "C_ideas" }, // configured category is C_general
                comments: {
                  totalCount: 0,
                  pageInfo: { hasNextPage: false },
                  nodes: [],
                },
              },
            },
          },
        },
      };
    });

    await expect(forum.getThread("42")).resolves.toBeUndefined();
  });

  it("returns a thread's comments for a matching category", async () => {
    const { forum } = await forumAgainst((request) => {
      if (operationNameOf(request.query) === "ForumIds")
        return { status: 200, body: { data: idsData } };
      return {
        status: 200,
        body: {
          data: {
            repository: {
              discussion: {
                ...discussionNode(),
                category: { id: "C_general" },
                comments: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: true },
                  nodes: [
                    {
                      id: "DC_1",
                      bodyText: "Nice pick.",
                      url: "https://github.com/o/r/discussions/42#comment",
                      createdAt: "2026-01-03T00:00:00.000Z",
                      author: { login: "operative" },
                    },
                  ],
                },
              },
            },
          },
        },
      };
    });

    const detail = await forum.getThread("42");
    expect(detail?.moreComments).toBe(true);
    expect(detail?.comments).toHaveLength(1);
    expect(detail?.comments[0]!.authorLogin).toBe("operative");
  });

  it("treats a non-canonical id as not found without an upstream call", async () => {
    const { forum, requests } = await forumAgainst(() => ({
      status: 200,
      body: { data: idsData },
    }));

    await expect(forum.getThread("007")).resolves.toBeUndefined();
    await expect(forum.getThread("-1")).resolves.toBeUndefined();
    await expect(forum.getThread("abc")).resolves.toBeUndefined();
    expect(
      requests.filter((r) => operationNameOf(r.query) === "ForumThread"),
    ).toHaveLength(0);
  });

  it("throws unavailable when the endpoint never responds in time", async () => {
    const { forum } = await forumAgainst(
      (request) => {
        if (operationNameOf(request.query) === "ForumIds")
          return { status: 200, body: { data: idsData } };
        return { status: 200, body: { data: {} }, delayMs: 500 };
      },
      { timeoutMs: 50, retries: 0 },
    );

    await expect(forum.listThreads()).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  it("never throws a DiscussionForumError other than the declared subclass", async () => {
    const { forum } = await forumAgainst(() => ({ status: 500, body: {} }), {
      retries: 0,
    });
    try {
      await forum.listThreads();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DiscussionForumError);
    }
  });
});
