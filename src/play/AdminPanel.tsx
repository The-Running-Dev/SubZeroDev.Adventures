import { useEffect, useState } from "react";
import type { BrowserDemo } from "./composition";

interface AdminPanelProps {
  readonly demo: BrowserDemo;
  readonly syncing: boolean;
  readonly syncError: string | undefined;
  /** Locale-formatted time of the last completed sync, or the initial load. */
  readonly lastSyncedAt: string;
  readonly onSync: () => void;
}

interface AdminCampaignStatus {
  readonly campaignId: string;
  readonly title: string;
  readonly kindId: string;
  readonly version: string;
  readonly endingCount: number;
}

interface AdminExtensionStatus {
  readonly id: string;
  readonly extends: string;
}

interface AdminSourceStatus {
  readonly id: string;
  readonly label: string;
  readonly kind: "url" | "pasted";
  readonly url?: string;
  readonly builtin: boolean;
  readonly removable: boolean;
  readonly lastSyncedAt?: string;
  readonly lastError?: string;
  readonly campaignCount?: number;
  readonly extensionCount?: number;
}

interface AdminContentStatus {
  readonly isAdmin: boolean;
  readonly status: {
    readonly campaignCount: number;
    readonly contentDigest?: string;
    readonly lastSuccessAt?: string;
    readonly lastFailureAt?: string;
    readonly lastError?: string;
    readonly bootstrapFallback?: boolean;
  };
  readonly campaigns: readonly AdminCampaignStatus[];
  readonly extensions: readonly AdminExtensionStatus[];
  readonly sources: readonly AdminSourceStatus[];
}

/** Short, no year -- an operator reading this is looking at "did that just happen," not an
 *  audit trail. `undefined` (a digest that's never been set, or a server that never fails)
 *  renders as an em dash rather than "Invalid Date". */
function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

/**
 * Reads `/api/admin/content/status` (issue #27) -- independent of the catalog `demo` this
 * component already receives, since it reports what the *server* is serving, not what this
 * tab last fetched. `refetchKey` is opaque to this hook -- `AdminPanel` folds together
 * "a sync just finished" and "a source was just added/removed" into one string so both
 * trigger a refetch without this hook needing to know about either.
 */
function useAdminContentStatus(
  apiUrl: string | undefined,
  refetchKey: string,
): {
  status: AdminContentStatus | undefined;
  error: string | undefined;
  refetch: () => void;
} {
  const [status, setStatus] = useState<AdminContentStatus>();
  const [error, setError] = useState<string>();
  const [manualToken, setManualToken] = useState(0);

  useEffect(() => {
    if (!apiUrl) return;
    let cancelled = false;
    fetch(`${apiUrl}/api/admin/content/status`, { credentials: "include" })
      .then((response) => {
        if (!response.ok)
          throw new Error(`status request failed: ${response.status}`);
        return response.json() as Promise<AdminContentStatus>;
      })
      .then((data) => {
        if (cancelled) return;
        setStatus(data);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `refetchKey`/`manualToken` are
    // the refetch triggers, not values read inside the effect.
  }, [apiUrl, refetchKey, manualToken]);

  return { status, error, refetch: () => setManualToken((t) => t + 1) };
}

function shortPreview(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * What an Add & Sync actually did. Three outcomes, not two, because a refresh is fail-closed
 * across *every* source: the add can succeed and the refresh still fail on a source the
 * operator never touched (the hardcoded default 404s until `SubZeroDev.Adventures.Content`
 * exists to serve it). Reporting that as one red "added, but the refresh failed" reads as
 * "your paste was rejected", which is the opposite of what happened -- the row is saved,
 * validated, and takes effect the moment the *other* source stops failing.
 */
interface AddOutcome {
  readonly tone: "ok" | "warn" | "error";
  readonly text: string;
}

/** `role="alert"` only for a real failure -- "added, and the catalog is live" interrupting a
 *  screen reader would be the same overstatement in audio that the red box was in colour. */
function AddOutcomeNote({ outcome }: { readonly outcome: AddOutcome }) {
  return (
    <p
      className={
        outcome.tone === "error"
          ? "admin-error"
          : outcome.tone === "warn"
            ? "admin-notice admin-notice-warn"
            : "admin-notice"
      }
      role={outcome.tone === "error" ? "alert" : "status"}
    >
      {outcome.text}
    </p>
  );
}

/**
 * An unlisted operator page, reachable only by adding `?admin` to the URL -- the same
 * door a hidden campaign uses (`PlayApp.tsx`'s `?campaign=` effect), and for the same
 * reason: this app has no router, so "a page nothing links to" is a query parameter and
 * a branch, not a route to exclude from a table.
 *
 * "Sync" means two things layered on top of each other. It always re-resolves the catalog
 * this browser holds (`createBrowserDemo()` again, refetching `/api/campaigns` or the
 * campaign JSON directly) -- worth having on its own, since the catalog is otherwise read
 * once at startup and frozen (`composition.ts`). In remote mode it *also* asks the server
 * to rebuild its own catalog first (`POST /api/admin/content/refresh`, issue #27), from
 * *every* configured content source at once -- there is no such thing as syncing one source
 * in isolation, since every source's content only ever ships as one merged, validated
 * catalog. `PlayApp.tsx`'s `onSync` handler is what sequences the two; every "Sync" button
 * on this page, including each source row's own, calls that same handler.
 *
 * Which is why a row whose last attempt *failed* offers no Sync button of its own: clicking
 * it would re-run the identical full refresh the page-level button already offers, and the
 * one thing it cannot do is fix the row it sits on. Fix or remove the source instead -- the
 * page-level Sync is still right there once you have.
 */
export function AdminPanel({
  demo,
  syncing,
  syncError,
  lastSyncedAt,
  onSync,
}: AdminPanelProps) {
  const [sourcesToken, setSourcesToken] = useState(0);
  const {
    status: adminStatus,
    error: statusError,
    refetch: refetchStatus,
  } = useAdminContentStatus(demo.apiUrl, `${lastSyncedAt}:${sourcesToken}`);
  const listed = demo.catalog.length;

  const [urlLabel, setUrlLabel] = useState("");
  const [urlValue, setUrlValue] = useState("");
  const [addingUrl, setAddingUrl] = useState(false);
  const [urlOutcome, setUrlOutcome] = useState<AddOutcome>();

  const [pasteText, setPasteText] = useState("");
  const [addingPaste, setAddingPaste] = useState(false);
  const [pasteOutcome, setPasteOutcome] = useState<AddOutcome>();

  const [removingId, setRemovingId] = useState<string>();
  const [removeError, setRemoveError] = useState<{
    readonly id: string;
    readonly text: string;
  }>();

  /** Throws only when nothing was created. A 201 always means the row exists, so every
   *  outcome from here on is a report about a source that is already saved. */
  async function postSource(body: unknown): Promise<AddOutcome> {
    const response = await fetch(`${demo.apiUrl}/api/admin/content/sources`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => undefined)) as
      | {
          error?: { code?: string };
          refresh?: { ok: boolean; error?: string };
          source?: { label?: string; lastError?: string };
        }
      | undefined;
    if (!response.ok) {
      throw new Error(
        json?.error?.code
          ? `${response.status} (${json.error.code})`
          : `${response.status}`,
      );
    }
    if (!json?.refresh || json.refresh.ok) {
      return {
        tone: "ok",
        text: "Added. The catalog rebuilt and is now live.",
      };
    }
    if (json.source?.lastError) {
      return {
        tone: "error",
        text: `Added, but this source failed to load: ${json.source.lastError}. It is saved, so you can fix the origin and Sync, or remove the row.`,
      };
    }
    // The added source loaded cleanly and something else didn't. Saying so is the point:
    // a refresh only publishes when every source succeeds, so this row is fine and simply
    // isn't live yet.
    return {
      tone: "warn",
      text: `Added, and this source itself loaded cleanly — but the catalog was not republished, because the refresh failed: ${json.refresh.error}. Fix or remove the failing source above, then Sync; this row takes effect then.`,
    };
  }

  async function handleAddUrl(): Promise<void> {
    setAddingUrl(true);
    setUrlOutcome(undefined);
    try {
      const outcome = await postSource({
        kind: "url",
        label: urlLabel,
        url: urlValue,
      });
      setUrlLabel("");
      setUrlValue("");
      setUrlOutcome(outcome);
      setSourcesToken((t) => t + 1);
      if (outcome.tone === "ok") onSync();
    } catch (error) {
      setUrlOutcome({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setAddingUrl(false);
    }
  }

  async function handleAddPaste(): Promise<void> {
    setAddingPaste(true);
    setPasteOutcome(undefined);
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(pasteText);
      } catch {
        throw new Error("that isn't valid JSON");
      }
      const outcome = await postSource({ kind: "pasted", payload });
      setPasteText("");
      setPasteOutcome(outcome);
      setSourcesToken((t) => t + 1);
      if (outcome.tone === "ok") onSync();
    } catch (error) {
      setPasteOutcome({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setAddingPaste(false);
    }
  }

  async function handleRemove(id: string): Promise<void> {
    if (!demo.apiUrl) return;
    setRemovingId(id);
    setRemoveError(undefined);
    try {
      const response = await fetch(
        `${demo.apiUrl}/api/admin/content/sources/${id}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!response.ok) {
        // Surface *why* the delete didn't happen -- a 403 (session isn't actually admin
        // anymore), a 404 (already gone), or a network failure all used to be swallowed
        // silently here, which reads identically to the button doing nothing at all.
        const json = (await response.json().catch(() => undefined)) as
          | { error?: { code?: string } }
          | undefined;
        throw new Error(
          json?.error?.code
            ? `${response.status} (${json.error.code})`
            : `request failed: ${response.status}`,
        );
      }
      refetchStatus();
    } catch (error) {
      setRemoveError({
        id,
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRemovingId(undefined);
    }
  }

  return (
    <main className="play-main admin">
      <h1 className="admin-title">Content admin</h1>
      <p className="admin-note">
        Unlisted. Nothing links here — this page exists at <code>?admin</code>{" "}
        only.
      </p>

      <section className="admin-block">
        <h2 className="admin-heading">Source</h2>
        <dl className="admin-facts">
          <dt>Mode</dt>
          <dd>{demo.apiUrl ? "Remote" : "In-browser"}</dd>
          <dt>Origin</dt>
          <dd>
            <code>{demo.apiUrl ?? "/campaigns/ (no backend configured)"}</code>
          </dd>
          <dt>Listed campaigns</dt>
          <dd>{listed}</dd>
          <dt>Last synced</dt>
          <dd>{lastSyncedAt}</dd>
        </dl>

        <button
          type="button"
          className="admin-sync"
          onClick={onSync}
          disabled={syncing}
        >
          {syncing ? "Syncing…" : "Sync catalog"}
        </button>

        {syncError !== undefined && (
          <p className="admin-error" role="alert">
            Sync failed: {syncError}
          </p>
        )}
      </section>

      {demo.apiUrl && (
        <section className="admin-block">
          <h2 className="admin-heading">Server content</h2>
          <dl className="admin-facts">
            <dt>Admin access</dt>
            <dd>
              {adminStatus
                ? adminStatus.isAdmin
                  ? "Allowed — this session can manage sources and trigger a server refresh"
                  : "Not allowed — Sync only re-fetches this tab's catalog"
                : "—"}
            </dd>
            <dt>Content digest</dt>
            <dd>
              <code>{adminStatus?.status.contentDigest ?? "—"}</code>
            </dd>
            <dt>Campaigns on server</dt>
            <dd>{adminStatus?.status.campaignCount ?? "—"}</dd>
            <dt>Last successful ingest</dt>
            <dd>{formatTimestamp(adminStatus?.status.lastSuccessAt)}</dd>
            <dt>Last failed ingest</dt>
            <dd>{formatTimestamp(adminStatus?.status.lastFailureAt)}</dd>
            {adminStatus?.status.lastError && (
              <>
                <dt>Failure reason</dt>
                <dd>{adminStatus.status.lastError}</dd>
              </>
            )}
          </dl>

          {adminStatus?.status.bootstrapFallback && (
            // The server started, but not from its own sources -- without saying so, the
            // catalog above looks like a normal one and the failure above looks historical.
            <p className="admin-notice admin-notice-warn" role="status">
              This server booted from the committed snapshot because its first
              build failed, and no sync has succeeded since. What is listed
              below is the snapshot, not what these sources say. Fix or remove
              the source named in the failure reason, then Sync.
            </p>
          )}

          {statusError !== undefined && (
            <p className="admin-error" role="alert">
              Could not read server status: {statusError}
            </p>
          )}
        </section>
      )}

      {demo.apiUrl && (
        <section className="admin-block">
          <h2 className="admin-heading">Content sources</h2>
          <p className="admin-note">
            Every source below merges into the one catalog above — there is no
            such thing as syncing a single row in isolation, so each row's Sync
            button triggers the same full refresh as the one at the top of the
            page. A row that failed its last attempt has no Sync button for that
            reason: fix or remove it, then sync the catalog.
          </p>
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Label</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Origin</th>
                  <th scope="col">Last synced</th>
                  <th scope="col">Last error</th>
                  <th scope="col">Campaigns</th>
                  <th scope="col">Extensions</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {(adminStatus?.sources ?? []).map((source) => (
                  <tr key={source.id}>
                    <td>
                      {source.label}
                      {source.builtin ? " (default)" : ""}
                    </td>
                    <td>{source.kind}</td>
                    <td>
                      <code>
                        {source.url ? shortPreview(source.url) : "pasted JSON"}
                      </code>
                    </td>
                    <td>{formatTimestamp(source.lastSyncedAt)}</td>
                    <td>
                      {source.lastError ? (
                        // Icon, not text: the full message is stacked fetch/validation
                        // output, and even a truncated preview was wide enough to force the
                        // horizontal scroll that hid the Remove button. The whole text stays
                        // one hover (or tap, via title) away, and is shown unabridged under
                        // "Server content" above when it's the one that failed the last
                        // refresh.
                        <span
                          className="admin-cell-error-icon"
                          title={source.lastError}
                          role="img"
                          aria-label={`Error: ${source.lastError}`}
                        >
                          ⚠
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{source.campaignCount ?? "—"}</td>
                    <td>{source.extensionCount ?? "—"}</td>
                    <td>
                      {!source.lastError && (
                        <button
                          type="button"
                          className="admin-sync admin-row-action"
                          onClick={onSync}
                          disabled={syncing}
                        >
                          Sync
                        </button>
                      )}
                      {source.removable && (
                        <button
                          type="button"
                          className="admin-remove admin-row-action"
                          onClick={() => void handleRemove(source.id)}
                          disabled={removingId === source.id}
                        >
                          {removingId === source.id ? "Removing…" : "Remove"}
                        </button>
                      )}
                      {removeError?.id === source.id && (
                        <p className="admin-cell-error-note" role="alert">
                          {removeError.text}
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
                {(adminStatus?.sources ?? []).length === 0 && (
                  <tr>
                    <td colSpan={8}>No sources yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="admin-form">
            <h3 className="admin-subheading">Add a URL source</h3>
            <div className="admin-form-row">
              <input
                type="text"
                placeholder="Label"
                value={urlLabel}
                onChange={(event) => setUrlLabel(event.target.value)}
              />
              <input
                type="text"
                placeholder="https://…/campaigns/"
                value={urlValue}
                onChange={(event) => setUrlValue(event.target.value)}
              />
              <button
                type="button"
                className="admin-sync"
                onClick={() => void handleAddUrl()}
                disabled={addingUrl || !urlLabel || !urlValue}
              >
                {addingUrl ? "Adding…" : "Add & Sync"}
              </button>
            </div>
            {urlOutcome && <AddOutcomeNote outcome={urlOutcome} />}
          </div>

          <div className="admin-form">
            <h3 className="admin-subheading">Paste a campaign or extension</h3>
            <textarea
              className="admin-paste"
              placeholder="Paste a whole campaign or extension JSON file here…"
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              rows={6}
            />
            <div className="admin-form-row">
              <button
                type="button"
                className="admin-sync"
                onClick={() => void handleAddPaste()}
                disabled={addingPaste || !pasteText.trim()}
              >
                {addingPaste ? "Adding…" : "Add & Sync"}
              </button>
            </div>
            {pasteOutcome && <AddOutcomeNote outcome={pasteOutcome} />}
          </div>
        </section>
      )}

      <section className="admin-block">
        <h2 className="admin-heading">Catalog</h2>
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Campaign</th>
                <th scope="col">Title</th>
                <th scope="col">Kind</th>
                <th scope="col">Version</th>
                <th scope="col">Endings</th>
              </tr>
            </thead>
            <tbody>
              {demo.catalog.map((campaign) => (
                <tr key={campaign.campaignId}>
                  <td>
                    <code>{campaign.campaignId}</code>
                  </td>
                  <td>{campaign.title}</td>
                  <td>{campaign.kindId}</td>
                  <td>
                    <code>{campaign.version}</code>
                  </td>
                  <td>{campaign.endingCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {demo.apiUrl && adminStatus && adminStatus.extensions.length > 0 && (
        <section className="admin-block">
          <h2 className="admin-heading">Extensions</h2>
          <div className="admin-table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Extension</th>
                  <th scope="col">Extends</th>
                </tr>
              </thead>
              <tbody>
                {adminStatus.extensions.map((extension) => (
                  <tr key={extension.id}>
                    <td>
                      <code>{extension.id}</code>
                    </td>
                    <td>
                      <code>{extension.extends}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
