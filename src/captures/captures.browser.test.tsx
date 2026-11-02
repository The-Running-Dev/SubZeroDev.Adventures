import { fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "../test/render";
import { MyCaptures } from "./MyCaptures";
import { ReportProblem } from "./ReportProblem";
import {
  assertMinHitArea,
  assertNoHorizontalOverflow,
} from "../test/browser/assertions";

const apiUrl = "https://api.invalid";
const capture = {
  captureId: "22222222-2222-4222-8222-222222222222",
  playerId: "33333333-3333-4333-8333-333333333333",
  sessionId: "11111111-1111-4111-8111-111111111111",
  campaignId: "the-bureaucracy-of-the-dead",
  trigger: "fault",
  createdAt: "2026-11-01T10:00:00.000Z",
  expiresAt: "2026-12-01T10:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/me")
        return Response.json({
          kind: "member",
          playerId: capture.playerId,
          displayName: "Reporter",
          signInProvider: null,
        });
      if (path === "/api/captures/consent")
        return Response.json({
          faultCapture: true,
          consentedAt: "2026-11-01T09:00:00.000Z",
        });
      if (path === "/api/captures")
        return Response.json({ captures: [capture] });
      if (path.startsWith("/api/admin/"))
        return Response.json({ isAdmin: false });
      throw Error(path);
    }),
  );
}

/** The play screen's marquee, as `PlayApp` lays it out around the report action. */
function Marquee({ apiUrl }: { apiUrl: string }) {
  return (
    <main className="play-main">
      <section className="cabinet">
        <header className="cabinet-marquee">
          <div>
            <p className="eyebrow">DISK 01</p>
            <h1>The Bureaucracy of the Dead</h1>
          </div>
          <div className="marquee-controls">
            <ReportProblem apiUrl={apiUrl} sessionId={capture.sessionId} />
            <button type="button" className="cabinet-button">
              Quit
            </button>
          </div>
        </header>
      </section>
    </main>
  );
}

it.each([320, 390, 768, 1280])(
  "keeps the open report panel inside the viewport at %dpx",
  async (width) => {
    await page.viewport(width, 900);
    stub();
    render(<Marquee apiUrl={apiUrl} />);
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    const panel = screen.getByRole("form", {
      name: "Report a problem with this session",
    });
    const box = panel.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(width);
    // Legible, not merely on screen: a panel squeezed to its button's width also "fits".
    expect(box.width).toBeGreaterThanOrEqual(Math.min(384, width) - 64);
    assertNoHorizontalOverflow();
    assertMinHitArea(screen.getByRole("checkbox").closest("label")!);
    for (const button of panel.querySelectorAll("button"))
      assertMinHitArea(button);
  },
);

it.each([320, 390, 1280])(
  "keeps the problem reports page usable at %dpx",
  async (width) => {
    await page.viewport(width, 900);
    stub();
    render(<MyCaptures apiUrl={apiUrl} />);
    await screen.findByText("the-bureaucracy-of-the-dead");
    await screen.findByText(/^Turned on/);
    assertNoHorizontalOverflow();
    for (const control of document.querySelectorAll(".feature-page button"))
      assertMinHitArea(control);
    assertMinHitArea(screen.getByRole("checkbox").closest("label")!);
  },
);
