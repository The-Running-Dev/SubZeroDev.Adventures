import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import PlayApp from "./PlayApp";
import manifestJson from "../../public/campaigns/manifest.json";
import whatWouldLuciferDoJson from "../../public/campaigns/what-would-lucifer-do.json";
import whatWouldLuciferDoEngineersCutJson from "../../public/campaigns/what-would-lucifer-do-engineers-cut.json";
import luciferChroniclesJson from "../../public/campaigns/lucifer-chronicles.json";
import bulgariaBureaucracyJson from "../../public/campaigns/bulgaria-bureaucracy.json";
import bulgariaReturnJson from "../../public/campaigns/bulgaria-return.json";
import bulgariaDrivingJson from "../../public/campaigns/bulgaria-driving.json";
import bulgariaInheritanceJson from "../../public/campaigns/bulgaria-inheritance.json";
import bulgariaEnterpriseJson from "../../public/campaigns/bulgaria-enterprise.json";
import sakiQuestJson from "../../public/campaigns/saki-quest-for-redemption.json";
import gettingStartedJson from "../../public/campaigns/getting-started.json";
import gettingStartedExtensionJson from "../../public/campaigns/getting-started-extension.json";

// SPIKE: same fetch stub as browser-client.test.ts — `PlayApp` now loads its catalog
// with a `fetch`, so every test must wait for that to resolve before the previously
// synchronous dossier-shelf queries below will find anything. See plans/spike-notes.md.
const exportedCampaigns: Readonly<Record<string, unknown>> = {
  "manifest.json": manifestJson,
  "what-would-lucifer-do.json": whatWouldLuciferDoJson,
  "what-would-lucifer-do-engineers-cut.json":
    whatWouldLuciferDoEngineersCutJson,
  "lucifer-chronicles.json": luciferChroniclesJson,
  "bulgaria-bureaucracy.json": bulgariaBureaucracyJson,
  "bulgaria-return.json": bulgariaReturnJson,
  "bulgaria-driving.json": bulgariaDrivingJson,
  "bulgaria-inheritance.json": bulgariaInheritanceJson,
  "bulgaria-enterprise.json": bulgariaEnterpriseJson,
  "saki-quest-for-redemption.json": sakiQuestJson,
  "getting-started.json": gettingStartedJson,
  "getting-started-extension.json": gettingStartedExtensionJson,
};
const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const fileName = url.split("/campaigns/")[1];
    const body = fileName ? exportedCampaigns[fileName] : undefined;
    if (body === undefined) throw new Error(`Unstubbed fetch: ${url}`);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/**
 * `.scene-body` splits its text into one `<span>` per character (the
 * per-character reveal animation), so it has no direct text-node children
 * left -- Testing Library's `getByText`/`findByText` only reads an
 * element's own text nodes, not full recursive `textContent`, so they can
 * never match here. `textContent` itself is unaffected and always complete,
 * so reading it directly is the correct replacement, not a workaround.
 */
async function findSceneBody(pattern: RegExp): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>(".scene-body");
    if (!el || !pattern.test(el.textContent ?? "")) {
      throw new Error(`.scene-body did not match ${pattern}`);
    }
    return el;
  });
}

const THEME_STORAGE_KEY = "subzerodev.play.theme.v1";

describe("PlayApp cabinet presentation", () => {
  /**
   * This suite is about the arcade-cabinet composition specifically (its
   * focus contract, its copy, its DOM) -- not whichever theme happens to be
   * the app's current default, which "PlayApp display theme" below tests
   * directly and deliberately leaves unpinned.
   */
  beforeEach(() => {
    localStorage.setItem(THEME_STORAGE_KEY, "dos");
  });

  it("renders a selectable dossier shelf and folds open a plain-language briefing", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);

    expect(
      await screen.findByRole("heading", { name: "Adventure disk library" }),
    ).toBeVisible();
    const dossier = screen.getByRole("button", { name: /The Bureaucracy/i });
    await user.click(dossier);

    expect(dossier).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText(
        "Municipal, cadastral, archive, notary, and translation routes through one determined folder.",
      ),
    ).toHaveClass("dossier-description");
    expect(screen.getByRole("button", { name: "Load" })).toBeVisible();
  });

  it("loads the adventure directly, with no interstitial notice to click through", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));
    await user.click(screen.getByRole("button", { name: "Load" }));

    expect(await findSceneBody(/handwritten/i)).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "Before loading this program" }),
    ).not.toBeInTheDocument();
  });

  it("shows a permanent link for the selected campaign that loads it directly", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));

    const link = screen.getByRole("link", { name: /\?campaign=/ });
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("?campaign=bulgaria-bureaucracy"),
    );
  });

  it("auto-loads the adventure named by a permanent ?campaign= link", async () => {
    const originalLocation = window.location.href;
    window.history.pushState({}, "", "/?campaign=bulgaria-bureaucracy");
    try {
      render(<PlayApp />);
      expect(await findSceneBody(/handwritten/i)).toBeVisible();
      expect(
        screen.queryByRole("heading", { name: "Adventure disk library" }),
      ).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, "", originalLocation);
    }
  });

  it("resumes an existing local save when opened via its permanent ?campaign= link, rather than restarting", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));
    await user.click(screen.getByRole("button", { name: "Load" }));
    await user.click(
      await screen.findByRole("button", {
        name: /Wait for the municipal registry/i,
      }),
    );
    const advancedScene =
      document.querySelector(".scene-body")?.textContent ?? "";
    expect(advancedScene).not.toMatch(/handwritten/i);
    unmount();

    const originalLocation = window.location.href;
    window.history.pushState({}, "", "/?campaign=bulgaria-bureaucracy");
    try {
      render(<PlayApp />);
      expect(
        await screen.findByRole("heading", { name: "The Bureaucracy" }),
      ).toBeVisible();
      expect(document.querySelector(".scene-body")?.textContent).toBe(
        advancedScene,
      );
      expect(
        screen.queryByRole("heading", { name: "Adventure disk library" }),
      ).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, "", originalLocation);
    }
  });

  it("ignores a submission that resolves after the player quits to the library", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));
    await user.click(screen.getByRole("button", { name: "Load" }));

    const action = await screen.findByRole("button", {
      name: /Wait for the municipal registry/i,
    });
    await act(async () => {
      action.click();
      screen.getByRole("button", { name: "Quit to library" }).click();
      await Promise.resolve();
    });

    expect(
      screen.getByRole("heading", { name: "Adventure disk library" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Quit to library" }),
    ).not.toBeInTheDocument();
  });

  it("starts the cabinet without exposing engine internals", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));
    await user.click(screen.getByRole("button", { name: "Load" }));

    expect(await findSceneBody(/handwritten/i)).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Player status" }),
    ).toBeVisible();
    expect(screen.getByText("GAME SAVED")).toBeVisible();
    expect(
      screen.queryByText(/actionLog|kindState|seed/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("PROGRAM LOADED. YOUR STORY BEGINS HERE."),
    ).toBeVisible();
  });

  it("marks the authored scene as a labelled region with a short real heading, not the prose itself (W66.8)", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));
    await user.click(screen.getByRole("button", { name: "Load" }));
    await findSceneBody(/handwritten/i);

    const region = screen.getByRole("region", { name: "Scene" });
    expect(region).toHaveFocus();
    expect(
      screen.queryByRole("heading", { name: /handwritten/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the choices with the scene, behind no cue control", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /Enterprise/i }));
    await user.click(screen.getByRole("button", { name: "Load" }));
    const deck = await waitFor(() => {
      const el = document.querySelector(".action-deck");
      expect(el?.querySelectorAll(".action-card").length ?? 0).toBeGreaterThan(
        0,
      );
      return el!;
    });
    expect(deck).toBeVisible();
    // The two-page phone model's cue and echo are gone in every theme.
    expect(screen.queryByRole("button", { name: /choices? ⌄/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Scene:/ })).toBeNull();
  });

  it("records only committed projected pages in the read-only journey", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));
    await user.click(screen.getByRole("button", { name: "Load" }));
    await user.click(
      await screen.findByRole("button", {
        name: /Wait for the municipal registry/i,
      }),
    );

    expect(screen.getByText("Last command")).toBeVisible();
    expect(screen.getByText("Wait for the municipal registry")).toBeVisible();
    expect(screen.getByText("// accepted")).toBeVisible();

    // The log opens with the run, so the journey is readable without a click.
    expect(screen.getByText(/Where I came from:/)).toBeVisible();
    expect(
      screen.queryByText(/actionLog|kindState|currentNodeId|seed/i),
    ).not.toBeInTheDocument();
  });

  it("gives the featured campaign its own cabinet identity, not the generic fallback", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(
      screen.getByRole("button", { name: /What Would Lucifer Do\?/i }),
    );
    await user.click(screen.getByRole("button", { name: "Load" }));

    expect(screen.getByText("PREDICTION LOG")).toBeVisible();
    expect(screen.queryByText("STORY IN PROGRESS")).not.toBeInTheDocument();
  });

  it("hides platform stats and the record toggle in local mode (no backend to ask)", async () => {
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    expect(
      screen.queryByRole("region", { name: "System activity" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Your record" }),
    ).not.toBeInTheDocument();
  });

  it("offers a resume for a campaign with a local save, and reloads that run", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));
    await user.click(screen.getByRole("button", { name: "Load" }));
    await user.click(
      await screen.findByRole("button", {
        name: /Wait for the municipal registry/i,
      }),
    );

    await user.click(screen.getByRole("button", { name: "Quit to library" }));
    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));
    const resumeButton = await screen.findByRole("button", {
      name: "Resume",
    });
    await user.click(resumeButton);

    expect(
      await screen.findByRole("heading", { name: "The Bureaucracy" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Adventure disk library" }),
    ).not.toBeInTheDocument();
  });
});

describe("PlayApp status console", () => {
  beforeEach(() => {
    localStorage.setItem(THEME_STORAGE_KEY, "dos");
  });

  async function openFlagship(): Promise<void> {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });
    await user.click(
      screen.getByRole("button", { name: /What Would Lucifer Do\?/i }),
    );
    await user.click(screen.getByRole("button", { name: "Load" }));
    await screen.findByRole("heading", { name: "Player status" });
  }

  it("reads a bounded stat against its declared ceiling, over a meter", async () => {
    await openFlagship();

    const rows = [...document.querySelectorAll(".stat-readouts div")];
    expect(rows.length).toBeGreaterThan(0);

    // Every visible variable in this campaign is a bounded int, so each row
    // carries the denominator the projection alone does not supply.
    for (const row of rows) {
      expect(row).toHaveClass("stat-metered");
      expect(row.querySelector(".stat-ceiling")?.textContent).toMatch(
        /\/\s*\d+/,
      );
    }
  });

  it("dims a stat still sitting at its floor rather than hiding it", async () => {
    await openFlagship();

    const rows = [...document.querySelectorAll(".stat-readouts div")];
    // Nothing has been earned on the opening scene, so every row starts idle
    // -- still present, because the set of stats says what the story measures.
    for (const row of rows) expect(row).toHaveClass("stat-idle");
  });

  it("shows the current turn", async () => {
    await openFlagship();
    expect(screen.getByText(/^Turn \d+$/)).toBeVisible();
  });

  it("opens the travel log with the run and counts its pages", async () => {
    await openFlagship();

    const log = document.querySelector<HTMLDetailsElement>(".journey-log")!;
    expect(log.open).toBe(true);
    expect(screen.getByText("1 page")).toBeVisible();
  });
});

describe("PlayApp display theme", () => {
  afterEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    delete document.documentElement.dataset.theme;
  });

  it("offers all four display modes with the default selected", async () => {
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    const select = screen.getByRole("combobox", { name: "DISPLAY MODE" });
    expect(select).toHaveValue("bbs");
    expect(
      screen.getByRole("option", { name: "DOS Blue" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Matrix" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Amber CRT" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Terminal" }),
    ).toBeInTheDocument();
  });

  it("applies the chosen theme to the document and persists it", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    const select = screen.getByRole("combobox", { name: "DISPLAY MODE" });
    await user.selectOptions(select, "matrix");

    expect(document.documentElement.dataset.theme).toBe("matrix");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("matrix");
  });

  it("applies a previously stored theme on mount", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "amber");
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("amber");
      expect(
        screen.getByRole("combobox", { name: "DISPLAY MODE" }),
      ).toHaveValue("amber");
    });
  });

  it("falls back to the default theme when storage throws", async () => {
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("Simulated storage failure");
      });

    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    expect(screen.getByRole("combobox", { name: "DISPLAY MODE" })).toHaveValue(
      "bbs",
    );

    spy.mockRestore();
  });
});

describe("PlayApp admin shell", () => {
  const originalLocation = window.location.href;

  afterEach(() => {
    window.history.pushState({}, "", originalLocation);
    localStorage.removeItem(THEME_STORAGE_KEY);
    delete document.documentElement.dataset.theme;
  });

  it("blocks the admin page when no authorized backend session exists", async () => {
    window.history.pushState({}, "", "/?admin");
    render(<PlayApp />);

    expect(
      await screen.findByRole("heading", { name: "Admin access required" }),
    ).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Disk library" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(
      screen.getByRole("combobox", { name: "DISPLAY MODE" }),
    ).toBeVisible();
    expect(document.querySelector("section.archive.admin")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Content admin" }),
    ).not.toBeInTheDocument();
  });
});

describe("PlayApp BBS Terminal prompt", () => {
  afterEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    delete document.documentElement.dataset.theme;
  });

  it("renders the prompt only once the BBS theme is active", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dos");
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    /*
     * The default theme is `bbs`, so `displayTheme`'s initial render value
     * is `bbs` too -- the stored "dos" preference only takes effect once
     * the mount effect that reads it has run. `waitFor` gives that a beat
     * instead of racing it.
     */
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Command" }),
      ).not.toBeInTheDocument();
    });
  });

  it("selects a disk by number, loads it, and takes an action by number", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "bbs");
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    const input = await screen.findByRole("textbox", { name: "Command" });
    await user.type(input, "3{enter}");
    expect(await screen.findByText(/Selected disk 3/)).toBeVisible();

    await user.type(input, "LOAD{enter}");
    await findSceneBody(/handwritten/i);
    const initialText = document.querySelector(".scene-body")?.textContent;

    await user.type(input, "1{enter}");
    await waitFor(() => {
      expect(document.querySelector(".scene-body")?.textContent).not.toBe(
        initialText,
      );
    });
  });

  it("returns ?Redo from start on unparseable input without changing state", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "bbs");
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    const input = await screen.findByRole("textbox", { name: "Command" });
    await user.type(input, "gibberish{enter}");

    expect(await screen.findByText("?Redo from start")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Adventure disk library" }),
    ).toBeVisible();
  });

  it("lists the current commands on HELP", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "bbs");
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    const input = await screen.findByRole("textbox", { name: "Command" });
    await user.type(input, "HELP{enter}");

    expect(
      await screen.findByText(/select a disk, LOAD, RESUME, HELP/),
    ).toBeVisible();
  });

  it("returns to the shelf on QUIT while playing", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "bbs");
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    const input = await screen.findByRole("textbox", { name: "Command" });
    await user.type(input, "3{enter}");
    await user.type(input, "LOAD{enter}");
    await findSceneBody(/handwritten/i);

    await user.type(input, "QUIT{enter}");
    expect(
      await screen.findByRole("heading", { name: "Adventure disk library" }),
    ).toBeVisible();
  });
});
