import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Discussions } from "./Discussions";
import type {
  DiscussionListData,
  DiscussionThreadData,
} from "../play/identity";

const sampleList: DiscussionListData = {
  configured: true,
  forum: "github",
  canPost: true,
  threads: [
    {
      id: "1",
      title: "Best disk in the shelf?",
      excerpt: "What is everyone's favourite campaign?",
      authorName: "ripcord",
      authorKind: "forum",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      commentCount: 2,
      url: "https://github.com/o/r/discussions/1",
    },
  ],
};

const sampleThread: DiscussionThreadData = {
  configured: true,
  forum: "github",
  canPost: true,
  thread: sampleList.threads[0]!,
  body: "What is everyone's favourite campaign right now?",
  comments: [
    {
      id: "c1",
      body: "Mine is What Would Lucifer Do.",
      authorName: "operative",
      createdAt: "2026-01-01T01:00:00.000Z",
      url: "https://github.com/o/r/discussions/1#c1",
    },
  ],
  moreComments: false,
};

function anonymousIdentity() {
  return {
    playerId: null,
    kind: "anonymous",
    displayName: null,
    signInProvider: null,
  };
}
function guestIdentity() {
  return {
    playerId: "guest-1",
    kind: "guest",
    displayName: null,
    signInProvider: "github",
  };
}
function memberIdentity() {
  return {
    playerId: "member-1",
    kind: "member",
    displayName: "Ada",
    signInProvider: "github",
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubFetch(routes: {
  me?: unknown;
  admin?: unknown;
  list?: { status: number; body: unknown };
  thread?: { status: number; body: unknown };
  post?: { status: number; body: unknown };
}) {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("/api/me")) {
        return new Response(JSON.stringify(routes.me ?? anonymousIdentity()), {
          status: 200,
        });
      }
      if (url.includes("/api/admin/content/status")) {
        return new Response(
          JSON.stringify(routes.admin ?? { isAdmin: false }),
          {
            status: 200,
          },
        );
      }
      if (method === "POST" && url.includes("/api/discussions")) {
        const { status, body } = routes.post ?? { status: 201, body: {} };
        return new Response(JSON.stringify(body), { status });
      }
      if (/\/api\/discussions\/\d+/.test(url)) {
        const { status, body } = routes.thread ?? {
          status: 200,
          body: sampleThread,
        };
        return new Response(JSON.stringify(body), { status });
      }
      if (url.includes("/api/discussions")) {
        const { status, body } = routes.list ?? {
          status: 200,
          body: sampleList,
        };
        return new Response(JSON.stringify(body), { status });
      }
      throw new Error(`Unstubbed fetch: ${method} ${url}`);
    },
  ) as typeof fetch;
  return calls;
}

describe("Discussions", () => {
  it("shows the unavailable message in local mode and issues no fetch", () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    render(<Discussions />);

    expect(
      screen.getByText("Discussions aren't available on this build."),
    ).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows a loading state, then the loaded list", async () => {
    stubFetch({});
    render(<Discussions apiUrl="http://localhost:8787" />);

    expect(screen.getByText("Loading…")).toBeVisible();
    expect(await screen.findByText("Best disk in the shelf?")).toBeVisible();
  });

  it("shows the empty-list message for no threads", async () => {
    stubFetch({ list: { status: 200, body: { ...sampleList, threads: [] } } });
    render(<Discussions apiUrl="http://localhost:8787" />);

    expect(
      await screen.findByText("No threads yet. Be the first."),
    ).toBeVisible();
  });

  it("shows the not-configured message for a 503 not_configured", async () => {
    stubFetch({
      list: {
        status: 503,
        body: { error: { operation: "discussions", code: "not_configured" } },
      },
    });
    render(<Discussions apiUrl="http://localhost:8787" />);

    expect(
      await screen.findByText(
        "Discussions aren't set up on this deployment yet.",
      ),
    ).toBeVisible();
  });

  it("shows the failure message for any other error", async () => {
    stubFetch({ list: { status: 500, body: {} } });
    render(<Discussions apiUrl="http://localhost:8787" />);

    expect(
      await screen.findByText(
        "The forum isn't reachable right now. Try again shortly.",
      ),
    ).toBeVisible();
  });

  it("shows a sign-in prompt and no compose form for a guest", async () => {
    stubFetch({ me: guestIdentity() });
    render(<Discussions apiUrl="http://localhost:8787" />);

    await screen.findByText("Best disk in the shelf?");
    expect(screen.getByText("Sign in to start a thread.")).toBeVisible();
    expect(screen.queryByPlaceholderText("Title")).toBeNull();
  });

  it("shows the compose form for a member and posts a new thread", async () => {
    const calls = stubFetch({
      me: memberIdentity(),
      post: {
        status: 201,
        body: {
          thread: {
            id: "2",
            title: "A new thread",
            excerpt: "hello",
            authorName: "Ada",
            authorKind: "player",
            createdAt: "2026-01-03T00:00:00.000Z",
            updatedAt: "2026-01-03T00:00:00.000Z",
            commentCount: 0,
            url: "https://github.com/o/r/discussions/2",
          },
          canPost: true,
        },
      },
    });
    const user = userEvent.setup();
    render(<Discussions apiUrl="http://localhost:8787" />);

    await screen.findByText("Best disk in the shelf?");
    await user.type(screen.getByPlaceholderText("Title"), "A new thread");
    await user.type(
      screen.getByPlaceholderText("What's on your mind?"),
      "hello",
    );
    await user.click(screen.getByRole("button", { name: "Post" }));

    expect(await screen.findByText("Posted.")).toBeVisible();
    expect(
      calls.some((c) =>
        c.startsWith("POST http://localhost:8787/api/discussions"),
      ),
    ).toBe(true);
  });

  it("renders a thread's body and comments when given a threadId", async () => {
    stubFetch({});
    render(<Discussions apiUrl="http://localhost:8787" threadId="1" />);

    expect(
      await screen.findByText(
        "What is everyone's favourite campaign right now?",
      ),
    ).toBeVisible();
    expect(screen.getByText("Mine is What Would Lucifer Do.")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "View on github" }),
    ).toHaveAttribute("href", "https://github.com/o/r/discussions/1");
  });

  it("shows a not-found message for a missing thread", async () => {
    stubFetch({
      thread: {
        status: 404,
        body: { error: { operation: "discussions", code: "not_found" } },
      },
    });
    render(<Discussions apiUrl="http://localhost:8787" threadId="999" />);

    expect(await screen.findByText("No such thread.")).toBeVisible();
  });

  it("links to the forum for the remaining comments when moreComments is true", async () => {
    stubFetch({
      thread: {
        status: 200,
        body: { ...sampleThread, moreComments: true },
      },
    });
    render(<Discussions apiUrl="http://localhost:8787" threadId="1" />);

    expect(
      await screen.findByRole("link", { name: "See the rest on github." }),
    ).toHaveAttribute("href", "https://github.com/o/r/discussions/1");
  });

  it("does not render the compose form on a thread-detail page", async () => {
    stubFetch({ me: memberIdentity() });
    render(<Discussions apiUrl="http://localhost:8787" threadId="1" />);

    await screen.findByText("What is everyone's favourite campaign right now?");
    expect(screen.queryByPlaceholderText("Title")).toBeNull();
  });
});
