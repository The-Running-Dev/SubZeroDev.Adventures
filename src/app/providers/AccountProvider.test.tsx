import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useQueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { AppProviders } from "./AppProviders";
import { useAccount } from "./AccountProvider";
import { useCampaigns } from "../../api/queries";

afterEach(() => vi.unstubAllGlobals());

it("cancels and removes account A's cache and rejects late results after an account switch", async () => {
  let player = "A";
  let resolveA!: (value: Response) => void;
  let oldSignal: AbortSignal | undefined;
  const late = new Promise<Response>((resolve) => {
    resolveA = resolve;
  });
  let client: ReturnType<typeof useQueryClient>;
  let catalogCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/me"))
        return Response.json({
          kind: "member",
          playerId: player,
          displayName: player,
          signInProvider: null,
        });
      if (url.endsWith("/api/campaigns")) {
        catalogCalls++;
        if (player === "A") {
          oldSignal = init?.signal as AbortSignal;
          return late;
        }
        return Response.json({
          campaigns: [{ campaignId: "private-B", title: "B only" }],
        });
      }
      return Response.json({ isAdmin: false });
    }),
  );
  function Probe() {
    const account = useAccount();
    client = useQueryClient();
    const catalog = useCampaigns(account.apiUrl);
    return (
      <>
        <button onClick={() => account.refreshIdentity()}>
          Change account
        </button>
        <p>
          {catalog.data?.campaigns.map((c) => c.title).join(",") ?? "waiting"}
        </p>
      </>
    );
  }
  render(
    <AppProviders apiUrl="https://api.example">
      <Probe />
      <Probe />
    </AppProviders>,
  );
  await waitFor(() => expect(catalogCalls).toBe(1));
  player = "B";
  fireEvent.click(screen.getAllByRole("button", { name: "Change account" })[0]);
  await screen.findAllByText("B only");
  expect(oldSignal?.aborted).toBe(true);
  await act(async () =>
    resolveA(
      Response.json({
        campaigns: [{ campaignId: "private-A", title: "A only" }],
      }),
    ),
  );
  expect(screen.queryByText("A only")).not.toBeInTheDocument();
  expect(
    client!
      .getQueryCache()
      .getAll()
      .filter((q) => q.queryKey[0] === "private" && q.queryKey[2] === "A"),
  ).toHaveLength(0);
  expect(catalogCalls).toBe(2);
});
