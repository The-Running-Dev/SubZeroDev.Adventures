import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ranking } from "./Ranking";
import { positionTitleFor } from "../play/ranking";
import type { RankingData } from "../play/identity";

const sampleRanking: RankingData = {
  entries: [
    {
      profileSlug: "leader",
      displayName: "Leader Operator",
      position: 1,
      absurdityIndex: 1234,
      badgeCount: 10,
      rejected: 50,
      endings: 5,
      moves: 2000,
      crowned: true,
    },
    {
      profileSlug: "second",
      displayName: "Second Operator",
      position: 2,
      absurdityIndex: 900,
      badgeCount: 8,
      rejected: 20,
      endings: 3,
      moves: 1000,
      crowned: false,
    },
  ],
  totalRanked: 2,
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubFetch(status: number, body: unknown) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/ranking")) {
      return new Response(JSON.stringify(body), { status });
    }
    throw new Error(`Unstubbed fetch: ${url}`);
  }) as typeof fetch;
}

describe("Ranking", () => {
  it("shows the unavailable message in local mode (no apiUrl) and issues no fetch", () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    render(<Ranking />);

    expect(
      screen.getByText("Standings aren't available on this build."),
    ).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows a loading state, then the loaded table", async () => {
    stubFetch(200, sampleRanking);
    render(<Ranking apiUrl="http://localhost:8787" />);

    expect(screen.getByText("Compiling standings…")).toBeVisible();
    expect(await screen.findByText("Leader Operator")).toBeVisible();
  });

  it("shows the empty-board message and no table for an empty payload", async () => {
    stubFetch(200, { entries: [], totalRanked: 0 });
    render(<Ranking apiUrl="http://localhost:8787" />);

    expect(
      await screen.findByText(
        "No public records on file. The ranking is technically complete.",
      ),
    ).toBeVisible();
    expect(document.querySelector("table")).toBeNull();
  });

  it("shows the failure message on a non-OK response", async () => {
    stubFetch(500, {});
    render(<Ranking apiUrl="http://localhost:8787" />);

    expect(
      await screen.findByText(/The standings are not currently available/),
    ).toBeVisible();
  });

  it("links each operator to their public profile by slug", async () => {
    stubFetch(200, sampleRanking);
    render(<Ranking apiUrl="http://localhost:8787" />);

    await screen.findByText("Leader Operator");
    expect(
      screen.getByRole("link", { name: "Leader Operator" }),
    ).toHaveAttribute("href", "/u/leader");
    expect(
      screen.getByRole("link", { name: "Second Operator" }),
    ).toHaveAttribute("href", "/u/second");
  });

  it("shows the standing title from positionTitleFor, not a hardcoded string", async () => {
    stubFetch(200, sampleRanking);
    render(<Ranking apiUrl="http://localhost:8787" />);

    await screen.findByText("Leader Operator");
    const secondTitle = positionTitleFor(2);
    expect(screen.getByText(secondTitle.label)).toBeVisible();
  });

  it("renders the crown block only for a crowned entry", async () => {
    stubFetch(200, sampleRanking);
    render(<Ranking apiUrl="http://localhost:8787" />);

    await screen.findByText("Leader Operator");
    expect(screen.getByText(/#1 \/\/ CURRENT/)).toBeVisible();
  });

  it("renders no crown block, and a below-threshold note, when nobody is crowned", async () => {
    stubFetch(200, {
      entries: sampleRanking.entries.map((e) => ({ ...e, crowned: false })),
      totalRanked: 2,
    });
    render(<Ranking apiUrl="http://localhost:8787" />);

    await screen.findByText("Leader Operator");
    expect(screen.queryByText(/#1 \/\/ CURRENT/)).toBeNull();
    expect(
      screen.getByText(
        "Too few public records to crown anyone. The top of a list of two is not an achievement.",
      ),
    ).toBeVisible();
  });

  it("formats numbers via Intl.NumberFormat rather than raw digits", async () => {
    stubFetch(200, sampleRanking);
    render(<Ranking apiUrl="http://localhost:8787" />);

    await screen.findByText("Leader Operator");
    const expected = new Intl.NumberFormat().format(2000);
    expect(screen.getByText(expected)).toBeVisible();
  });
});
