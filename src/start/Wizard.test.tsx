/**
 * The wizard's two load-bearing claims, tested end to end through the UI:
 *
 *  - the playtest step runs the draft in the **real engine** (a scene the author typed comes
 *    back out of `BrowserClient`, and a choice they wrote advances it), and
 *  - the submit step posts the draft down the **existing** `/api/content` `"pasted"` route,
 *    as a payload `classifyPastedPayload` classifies as a campaign.
 *
 * Both are things a plausible-looking stub would also appear to satisfy, which is why they
 * are asserted against real output rather than against the component's own state.
 */
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Wizard } from "./Wizard";
import { clearDraft, saveDraft } from "./draft";
import { completeDraft } from "./draft.test";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  clearDraft();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Seeds a valid draft into storage, then mounts -- the wizard reads it on the first render. */
async function mountWithCompleteDraft(apiUrl?: string) {
  saveDraft(completeDraft());
  const user = userEvent.setup();
  render(<Wizard apiUrl={apiUrl} onExit={() => {}} />);
  await screen.findByDisplayValue("Test Campaign");
  return user;
}

describe("Wizard — stored draft", () => {
  it("does not overwrite a stored draft with the empty one while loading it", () => {
    // Regression: reading the draft in a mount effect let the save effect -- which runs in
    // the same commit, before the load's state update applies -- write the empty draft over
    // the author's, and StrictMode's second pass then read that back. The author's work was
    // gone on reload, with a perfectly valid-looking empty draft in its place.
    //
    // `StrictMode` is not decoration here: it is the double effect invocation that turns the
    // clobber into permanent loss, and it is how `main.tsx` renders this app. Without it this
    // spec passes against the defect. Asserted against storage rather than the form, because
    // the form showed the right thing either way -- only the next reload differed.
    saveDraft(completeDraft());
    render(
      <StrictMode>
        <Wizard onExit={() => {}} />
      </StrictMode>,
    );
    const stored = JSON.parse(
      localStorage.getItem("subzerodev.play.draft.v1")!,
    ) as { id: string };
    expect(stored.id).toBe("test-campaign");
  });
});

describe("Wizard — start from a sample", () => {
  it("loads the sample and opens on the playtest step, where it runs once named", async () => {
    const user = userEvent.setup();
    render(<Wizard onExit={() => {}} />);
    await user.click(
      screen.getByRole("button", { name: /START FROM A SAMPLE/ }),
    );

    expect(
      screen.getByText(/CAMPAIGN AUTHORING — PLAYTEST/),
    ).toBeInTheDocument();

    // Unnamed, so the existing gate holds: the sample adds no gate of its own, and clears
    // this one the moment the author supplies a title.
    expect(screen.getByRole("button", { name: "RUN ▸" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /^1\) Identity$/ }));
    await user.type(screen.getByLabelText("Title"), "The Last Tram");
    await user.click(screen.getByRole("button", { name: /^5\) Playtest$/ }));
    await user.click(screen.getByRole("button", { name: "RUN ▸" }));

    // The sample's own opening scene, back out of the real engine via `BrowserClient` --
    // the same path a hand-authored draft takes.
    expect(
      await screen.findByText(/The last tram left nine minutes ago/),
    ).toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", { name: /Start walking\./ }),
    );
    expect(
      await screen.findByText(/The river is black under the bridge/),
    ).toBeInTheDocument();
  });

  it("loads without confirming when there is nothing to lose", async () => {
    const user = userEvent.setup();
    render(<Wizard onExit={() => {}} />);
    await user.click(
      screen.getByRole("button", { name: /START FROM A SAMPLE/ }),
    );
    expect(
      screen.queryByText(/This replaces the draft you already have/),
    ).not.toBeInTheDocument();
  });

  it("confirms before replacing a draft the author has already worked on", async () => {
    const user = await mountWithCompleteDraft();
    await user.click(
      screen.getByRole("button", { name: /START FROM A SAMPLE/ }),
    );

    // Still on identity, still the author's own draft, and nothing written to storage yet.
    expect(screen.getByDisplayValue("Test Campaign")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Keep what I have/ }));
    expect(screen.getByDisplayValue("Test Campaign")).toBeInTheDocument();
    expect(
      (
        JSON.parse(localStorage.getItem("subzerodev.play.draft.v1")!) as {
          id: string;
        }
      ).id,
    ).toBe("test-campaign");

    await user.click(
      screen.getByRole("button", { name: /START FROM A SAMPLE/ }),
    );
    await user.click(screen.getByRole("button", { name: /REPLACE MY DRAFT/ }));
    expect(
      screen.getByText(/CAMPAIGN AUTHORING — PLAYTEST/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        (
          JSON.parse(localStorage.getItem("subzerodev.play.draft.v1")!) as {
            startNodeId: string;
          }
        ).startNodeId,
      ).toBe("platform"),
    );
  });
});

describe("Wizard — validation console", () => {
  it("reports a fresh draft's findings without blocking navigation", async () => {
    const user = userEvent.setup();
    render(<Wizard onExit={() => {}} />);

    expect(screen.getByText(/VALIDATION — 3 to fix/)).toBeInTheDocument();
    expect(
      screen.getByText(/Campaign id must be lower-case words/),
    ).toBeInTheDocument();

    // Invalid, and still able to move between steps -- the whole point of not gating steps.
    await user.click(screen.getByRole("button", { name: "ENTER CONTINUE" }));
    expect(screen.getByText(/CAMPAIGN AUTHORING — STATS/)).toBeInTheDocument();
  });

  it("clears as the author fixes the draft", async () => {
    await mountWithCompleteDraft();
    expect(
      screen.getByText(/VALIDATION — passes; ready to play and submit/),
    ).toBeInTheDocument();
    expect(screen.getByText("No findings.")).toBeInTheDocument();
  });

  it("re-validates live when a field changes", async () => {
    const user = await mountWithCompleteDraft();
    const id = screen.getByDisplayValue("test-campaign");
    await user.clear(id);
    await user.type(id, "Not Kebab");
    expect(
      await screen.findByText(/Campaign id must be lower-case words/),
    ).toBeInTheDocument();
  });
});

describe("Wizard — playtest", () => {
  it("runs the author's own draft through the real engine", async () => {
    const user = await mountWithCompleteDraft();
    await user.click(screen.getByRole("button", { name: /^5\) Playtest$/ }));
    await user.click(screen.getByRole("button", { name: "RUN ▸" }));

    // The scene text and the choice label are the author's own, arriving back through
    // `BrowserClient` -- not rendered from the draft.
    expect(
      await screen.findByText("You are at the start."),
    ).toBeInTheDocument();
    const choice = await screen.findByRole("button", { name: /Go on\./ });

    await user.click(choice);
    expect(await screen.findByText("It is over.")).toBeInTheDocument();
    expect(screen.getByText("ENDING REACHED")).toBeInTheDocument();
  });

  it("refuses to run a draft that does not validate", async () => {
    const user = userEvent.setup();
    render(<Wizard onExit={() => {}} />);
    await user.click(screen.getByRole("button", { name: /^5\) Playtest$/ }));
    expect(screen.getByRole("button", { name: "RUN ▸" })).toBeDisabled();
    expect(
      screen.getByText(/Fix the findings below first/),
    ).toBeInTheDocument();
  });

  it("drops a run when the draft is edited underneath it", async () => {
    const user = await mountWithCompleteDraft();
    await user.click(screen.getByRole("button", { name: /^5\) Playtest$/ }));
    await user.click(screen.getByRole("button", { name: "RUN ▸" }));
    await screen.findByText("You are at the start.");

    await user.click(screen.getByRole("button", { name: /^1\) Identity$/ }));
    await user.type(screen.getByDisplayValue("Test Campaign"), "!");
    await user.click(screen.getByRole("button", { name: /^5\) Playtest$/ }));

    expect(
      await screen.findByText(
        /that run was against content that no longer exists/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("You are at the start.")).not.toBeInTheDocument();
  });

  it("writes no save into the shelf's storage", async () => {
    const user = await mountWithCompleteDraft();
    await user.click(screen.getByRole("button", { name: /^5\) Playtest$/ }));
    await user.click(screen.getByRole("button", { name: "RUN ▸" }));
    await screen.findByText("You are at the start.");

    // A playtest that persisted would leave `subzerodev.play.save.v1.*` keys the disk shelf
    // then offers to resume -- for a campaign only this author's draft defines.
    const keys = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index),
    );
    expect(
      keys.filter((key) => key?.startsWith("subzerodev.play.save.")),
    ).toEqual([]);
  });
});

describe("Wizard — submit", () => {
  it("posts the draft as a pasted campaign to /api/content", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ source: {}, refresh: { ok: true } }), {
          status: 201,
        }),
    );
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/me"))
        return Promise.resolve(
          new Response(JSON.stringify({ kind: "player", playerId: "p1" }), {
            status: 200,
          }),
        );
      return fetchMock(input, init);
    }) as typeof fetch;

    const user = await mountWithCompleteDraft("https://api.example");
    await user.click(screen.getByRole("button", { name: /^6\) Submit$/ }));
    const submit = await screen.findByRole("button", { name: "SUBMIT ▸" });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(String(url)).toBe("https://api.example/api/content");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");

    const body = JSON.parse(String(init.body)) as {
      kind: string;
      label: string;
      payload: Record<string, unknown>;
    };
    expect(body.kind).toBe("pasted");
    expect(body.label).toBe("Test Campaign");
    // `classifyPastedPayload` decides "campaign" on exactly these two keys.
    expect(body.payload).toHaveProperty("campaign");
    expect(body.payload).toHaveProperty("catalog");
    expect(body.payload.formatVersion).toBe(2);
  });

  it("will not submit while the draft is invalid", async () => {
    const user = userEvent.setup();
    render(<Wizard apiUrl="https://api.example" onExit={() => {}} />);
    await user.click(screen.getByRole("button", { name: /^6\) Submit$/ }));
    expect(screen.getByRole("button", { name: "SUBMIT ▸" })).toBeDisabled();
    expect(
      screen.getByText(/has to validate before it can be submitted/),
    ).toBeInTheDocument();
  });

  it("says there is nowhere to submit on a build with no API", async () => {
    const user = await mountWithCompleteDraft();
    await user.click(screen.getByRole("button", { name: /^6\) Submit$/ }));
    expect(
      screen.getByText(/no server configured, so there is nowhere to submit/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "SUBMIT ▸" })).toBeDisabled();
  });
});
