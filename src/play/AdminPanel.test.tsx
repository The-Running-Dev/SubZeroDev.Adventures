import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminPanel } from "./AdminPanel";
import type { BrowserDemo } from "./composition";

const apiUrl = "https://api.example.test";
const demo = { apiUrl, catalog: [] } as unknown as BrowserDemo;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function status(isAdmin: boolean, sources: readonly unknown[] = []) {
  return {
    isAdmin,
    status: { campaignCount: 10 },
    campaigns: [],
    extensions: [],
    sources,
  };
}

function renderPanel(onSync = vi.fn()): void {
  render(
    <AdminPanel
      demo={demo}
      syncing={false}
      syncError={undefined}
      lastSyncedAt="—"
      onSync={onSync}
    />,
  );
}

function pasteAddButton(textarea: HTMLElement): HTMLElement {
  const form = textarea.closest(".admin-form") as HTMLElement | null;
  if (!form) throw new Error("paste form was not rendered");
  return within(form).getByRole("button", { name: "Add & Sync" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdminPanel authorization", () => {
  it("keeps source management disabled for a non-admin session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          response(
            status(false, [
              {
                id: "pasted-source",
                label: "Existing source",
                kind: "pasted",
                builtin: false,
                removable: true,
              },
            ]),
          ),
        ),
      ),
    );

    renderPanel();

    expect(
      await screen.findByText(/source management needs an authorized session/i),
    ).toBeVisible();
    expect(screen.getByPlaceholderText("Label")).toBeDisabled();
    expect(
      screen.getByPlaceholderText(
        "Paste a whole campaign or extension JSON file here…",
      ),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(
      screen.getByRole("link", { name: /sign in on the main page/i }),
    ).toHaveAttribute("href", "/");
  });

  it("refreshes authorization and preserves pasted JSON after a forbidden add", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/status")) {
        const statusCallCount = fetchMock.mock.calls.filter(([request]) =>
          request.toString().endsWith("/status"),
        ).length;
        return Promise.resolve(response(status(statusCallCount === 1)));
      }
      return Promise.resolve(response({ error: { code: "forbidden" } }, 403));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const pasted = '{"campaign":{"id":"still-here"}}';

    renderPanel();
    const textarea = await screen.findByPlaceholderText(
      "Paste a whole campaign or extension JSON file here…",
    );
    await waitFor(() => expect(textarea).toBeEnabled());
    fireEvent.change(textarea, { target: { value: pasted } });
    await user.click(pasteAddButton(textarea));

    expect(
      await screen.findByText(/your admin session is no longer authorized/i),
    ).toBeVisible();
    await waitFor(() => expect(textarea).toBeDisabled());
    expect(textarea).toHaveValue(pasted);
    expect(
      fetchMock.mock.calls.filter(([request]) =>
        request.toString().endsWith("/status"),
      ),
    ).toHaveLength(2);
  });

  it("reports a successful add without treating it as an authorization failure", async () => {
    const onSync = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          input.toString().endsWith("/status")
            ? response(status(true))
            : response({ refresh: { ok: true } }, 201),
        ),
      ),
    );
    const user = userEvent.setup();

    renderPanel(onSync);
    const textarea = await screen.findByPlaceholderText(
      "Paste a whole campaign or extension JSON file here…",
    );
    await waitFor(() => expect(textarea).toBeEnabled());
    fireEvent.change(textarea, { target: { value: "{}" } });
    await user.click(pasteAddButton(textarea));

    expect(
      await screen.findByText("Added. The catalog rebuilt and is now live."),
    ).toBeVisible();
    expect(onSync).toHaveBeenCalledOnce();
    expect(screen.queryByText(/no longer authorized/i)).not.toBeInTheDocument();
  });

  it("uploads a JSON file through the same pasted-source request", async () => {
    const onSync = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        input.toString().endsWith("/status")
          ? response(status(true))
          : response({ refresh: { ok: true } }, 201),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const file = new File(["unused"], "bulgarian-adventures.json", {
      type: "application/json",
    });
    Object.defineProperty(file, "text", {
      value: () => Promise.resolve('{"campaign":{"id":"from-file"}}'),
    });

    renderPanel(onSync);
    const input = await screen.findByLabelText("JSON file");
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { files: [file] } });

    expect(
      await screen.findByText("Selected: bulgarian-adventures.json"),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Upload & Sync" }));

    expect(
      await screen.findByText("Added. The catalog rebuilt and is now live."),
    ).toBeVisible();
    const sourceCall = fetchMock.mock.calls.find(([request]) =>
      request.toString().endsWith("/sources"),
    );
    expect(sourceCall).toBeDefined();
    expect(JSON.parse(String(sourceCall?.[1]?.body))).toEqual({
      kind: "pasted",
      payload: { campaign: { id: "from-file" } },
    });
    expect(onSync).toHaveBeenCalledOnce();
  });

  it("keeps non-authorization failures distinct", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          input.toString().endsWith("/status")
            ? response(status(true))
            : response({ error: { code: "unrecognized_payload_shape" } }, 400),
        ),
      ),
    );
    const user = userEvent.setup();

    renderPanel();
    const textarea = await screen.findByPlaceholderText(
      "Paste a whole campaign or extension JSON file here…",
    );
    await waitFor(() => expect(textarea).toBeEnabled());
    fireEvent.change(textarea, { target: { value: "{}" } });
    await user.click(pasteAddButton(textarea));

    expect(
      await screen.findByText("400 (unrecognized_payload_shape)"),
    ).toBeVisible();
    expect(screen.queryByText(/no longer authorized/i)).not.toBeInTheDocument();
    expect(textarea).toBeEnabled();
  });
});
