import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "../test/render";
import { MyCaptures } from "./MyCaptures";
import { ReportProblem } from "./ReportProblem";
import { AdminCaptures } from "../features/admin/AdminCaptures";
import type { BrowserDemo } from "../play/composition";
import type { CaptureSummary } from "../api/captures";

const apiUrl = "https://api.invalid";
const sessionId = "11111111-1111-4111-8111-111111111111";
const summary = {
  captureId: "22222222-2222-4222-8222-222222222222",
  playerId: "33333333-3333-4333-8333-333333333333",
  sessionId,
  campaignId: "bureaucracy",
  trigger: "report",
  createdAt: "2026-11-01T10:00:00.000Z",
  expiresAt: "2026-12-01T10:00:00.000Z",
} as const;

type Handler = (path: string, init?: RequestInit) => Response | undefined;

let online = true;
beforeEach(() => {
  online = true;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stub(handler: Handler, { admin = false } = {}) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/me")
        return Response.json({
          kind: "member",
          playerId: summary.playerId,
          displayName: "Reporter",
          signInProvider: null,
        });
      const handled = handler(path, init);
      if (handled) return handled;
      if (path === "/api/admin/status" || path.startsWith("/api/admin/"))
        return Response.json({ isAdmin: admin });
      throw Error(`unexpected ${init?.method ?? "GET"} ${path}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function calls(fetchMock: ReturnType<typeof stub>, method: string) {
  return fetchMock.mock.calls
    .filter(([, init]) => (init?.method ?? "GET") === method)
    .map(([input, init]) => ({
      path: new URL(String(input)).pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }));
}

/** The account providers read the API from the rendered element's own `apiUrl` prop. */
function Admin({ apiUrl }: { apiUrl: string }) {
  return <AdminCaptures demo={{ apiUrl } as BrowserDemo} />;
}

const refusal = (status: number, code: string) =>
  Response.json({ error: { operation: "capture", code } }, { status });

it("sends a report only after the consent box is ticked, and links to the reports page", async () => {
  const fetchMock = stub((path, init) =>
    path === `/api/sessions/${sessionId}/capture` && init?.method === "POST"
      ? Response.json(summary, { status: 201 })
      : undefined,
  );
  render(<ReportProblem apiUrl={apiUrl} sessionId={sessionId} />);
  const toggle = screen.getByRole("button", { name: "Report a problem" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");

  const panel = screen.getByRole("form", {
    name: "Report a problem with this session",
  });
  const consent = within(panel).getByRole("checkbox");
  expect(consent).not.toBeChecked();
  expect(panel).toHaveTextContent(/random seed/);
  expect(panel).toHaveTextContent(/30 days/);
  const send = within(panel).getByRole("button", { name: "Send report" });
  expect(send).toBeDisabled();

  fireEvent.click(consent);
  expect(send).toBeEnabled();
  fireEvent.click(send);

  expect(await screen.findByRole("status")).toHaveTextContent("Report sent.");
  expect(
    screen.getByRole("link", { name: "your problem reports" }),
  ).toHaveAttribute("href", "/captures");
  expect(calls(fetchMock, "POST")).toEqual([
    { path: `/api/sessions/${sessionId}/capture`, body: { consent: true } },
  ]);
  expect(consent).not.toBeChecked();
});

it.each([
  [400, "consent_required", "Tick the box to agree before sending a report."],
  [403, "forbidden", "This session is not yours to report."],
  [
    403,
    "campaign_access_revoked",
    "You no longer have access to this adventure, so its session can't be reported.",
  ],
  [404, "unknown_session", "This session could not be found."],
  [404, "unknown_campaign", "This session's adventure is no longer available."],
  [
    409,
    "invalid_state",
    "This session can't be captured in its current state.",
  ],
  [
    410,
    "campaign_deleted",
    "This adventure has been deleted, so its session can't be reported.",
  ],
  [
    503,
    "storage_failure",
    "The report could not be saved right now. Try again shortly.",
  ],
  [409, "some_new_code", "The report could not be sent. Try again."],
])(
  "explains a %d %s refusal in the player's language",
  async (status, code, message) => {
    stub((path) =>
      path === `/api/sessions/${sessionId}/capture`
        ? refusal(status, code)
        : undefined,
    );
    render(<ReportProblem apiUrl={apiUrl} sessionId={sessionId} />);
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  },
);

it("keeps the report button disabled offline", async () => {
  online = false;
  const fetchMock = stub(() => undefined);
  render(<ReportProblem apiUrl={apiUrl} sessionId={sessionId} />);
  fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByText("Reconnect to send a report.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Send report" })).toBeDisabled();
  expect(calls(fetchMock, "POST")).toEqual([]);
});

it("turns automatic fault capture on and shows when consent was given", async () => {
  let consent = { faultCapture: false, consentedAt: null as string | null };
  const fetchMock = stub((path, init) => {
    if (path === "/api/captures/consent") {
      if (init?.method === "POST")
        consent = {
          faultCapture: JSON.parse(String(init.body)).faultCapture,
          consentedAt: "2026-11-02T09:30:00.000Z",
        };
      return Response.json(consent);
    }
    if (path === "/api/captures") return Response.json({ captures: [] });
    return undefined;
  });
  render(<MyCaptures apiUrl={apiUrl} />);
  const toggle = await screen.findByRole("checkbox", {
    name: "Save a report automatically when a session fails",
  });
  expect(toggle).not.toBeChecked();
  expect(screen.getByText("Off.")).toBeVisible();

  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(await screen.findByText(/^Turned on .*2026/)).toBeVisible();
  expect(calls(fetchMock, "POST")).toEqual([
    { path: "/api/captures/consent", body: { faultCapture: true } },
  ]);
});

it("lists, downloads and deletes the player's own reports", async () => {
  const second: CaptureSummary = {
    ...summary,
    captureId: "44444444-4444-4444-8444-444444444444",
    trigger: "fault",
  };
  let rows: CaptureSummary[] = [summary, second];
  const fetchMock = stub((path, init) => {
    const method = init?.method ?? "GET";
    if (path === "/api/captures/consent")
      return Response.json({ faultCapture: false, consentedAt: null });
    if (path === "/api/captures" && method === "GET")
      return Response.json({ captures: rows });
    if (path === "/api/captures" && method === "DELETE") {
      const deleted = rows.length;
      rows = [];
      return Response.json({ deleted });
    }
    if (path === `/api/captures/${summary.captureId}` && method === "GET")
      return Response.json({ ...summary, fixture: { seed: 7 } });
    if (path === `/api/captures/${second.captureId}` && method === "DELETE") {
      rows = rows.filter((row) => row.captureId !== second.captureId);
      return new Response(null, { status: 204 });
    }
    return undefined;
  });
  const createObjectURL = vi.fn(() => "blob:capture");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL, revokeObjectURL }),
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});

  render(<MyCaptures apiUrl={apiUrl} />);
  const table = await screen.findByRole("table");
  await within(table).findByText("Automatic");
  expect(within(table).getAllByRole("row")).toHaveLength(3);

  fireEvent.click(
    within(table).getAllByRole("button", { name: "Download" })[0]!,
  );
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  const anchor = click.mock.contexts[0] as HTMLAnchorElement;
  expect(anchor.download).toBe(`capture-${summary.captureId}.json`);
  expect(createObjectURL).toHaveBeenCalledOnce();

  fireEvent.click(within(table).getAllByRole("button", { name: "Delete" })[1]!);
  await waitFor(() =>
    expect(within(table).queryByText("Automatic")).not.toBeInTheDocument(),
  );

  fireEvent.click(screen.getByRole("button", { name: "Delete all reports" }));
  expect(await within(table).findByText("No problem reports.")).toBeVisible();
  expect(calls(fetchMock, "DELETE").map((call) => call.path)).toEqual([
    `/api/captures/${second.captureId}`,
    "/api/captures",
  ]);
});

it("explains why the reports page is empty without an API or a principal", async () => {
  stub(() => undefined);
  const { unmount } = render(<MyCaptures />);
  expect(
    await screen.findByText("Problem reports aren't available on this build."),
  ).toBeVisible();
  unmount();
});

it("lets an admin list every capture and capture a session on a player's behalf", async () => {
  let rows: CaptureSummary[] = [summary];
  const captured = {
    ...summary,
    captureId: "55555555-5555-4555-8555-555555555555",
  };
  const fetchMock = stub(
    (path, init) => {
      if (path === "/api/admin/captures" && init?.method === "POST") {
        rows = [...rows, captured];
        return Response.json(captured, { status: 201 });
      }
      if (path === "/api/admin/captures")
        return Response.json({ captures: rows });
      return undefined;
    },
    { admin: true },
  );
  render(<Admin apiUrl={apiUrl} />);
  const table = await screen.findByRole("table");
  await within(table).findByText("bureaucracy");

  const submit = screen.getByRole("button", { name: "Capture session" });
  fireEvent.change(screen.getByRole("textbox", { name: "Session id" }), {
    target: { value: ` ${sessionId} ` },
  });
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(submit);

  expect(await screen.findByRole("status")).toHaveTextContent(
    `Captured ${captured.captureId}.`,
  );
  await waitFor(() =>
    expect(within(table).getAllByRole("row")).toHaveLength(3),
  );
  expect(calls(fetchMock, "POST")).toEqual([
    { path: "/api/admin/captures", body: { sessionId, consent: true } },
  ]);
});

it("renders nothing of the admin captures for a non-admin", async () => {
  const fetchMock = stub(() => undefined);
  render(<Admin apiUrl={apiUrl} />);
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/api/admin/"),
      ),
    ).toBe(true),
  );
  expect(screen.queryByText("Session captures")).not.toBeInTheDocument();
  expect(
    fetchMock.mock.calls.some(([input]) =>
      String(input).endsWith("/api/admin/captures"),
    ),
  ).toBe(false);
});
