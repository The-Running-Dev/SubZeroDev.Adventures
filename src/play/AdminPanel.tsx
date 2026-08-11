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

interface AdminContentStatus {
  readonly isAdmin: boolean;
  readonly status: {
    readonly campaignCount: number;
    readonly contentDigest?: string;
    readonly lastSuccessAt?: string;
    readonly lastFailureAt?: string;
    readonly lastError?: string;
  };
  readonly campaigns: readonly AdminCampaignStatus[];
  readonly extensions: readonly AdminExtensionStatus[];
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
 * tab last fetched. Refetched after every sync (`lastSyncedAt` in the dependency array) so a
 * refresh's outcome shows up here even when the sync itself came back with a soft error
 * (`syncError`, e.g. "not an admin" rather than a network failure).
 */
function useAdminContentStatus(
  apiUrl: string | undefined,
  lastSyncedAt: string,
): { status: AdminContentStatus | undefined; error: string | undefined } {
  const [status, setStatus] = useState<AdminContentStatus>();
  const [error, setError] = useState<string>();

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `lastSyncedAt` is the refetch
    // trigger, not a value read inside the effect.
  }, [apiUrl, lastSyncedAt]);

  return { status, error };
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
 * to rebuild its own catalog first (`POST /api/admin/content/refresh`, issue #27), so a
 * campaign or extension published since the server last read it is actually there to fetch
 * -- `PlayApp.tsx`'s `onSync` handler is what sequences the two.
 */
export function AdminPanel({
  demo,
  syncing,
  syncError,
  lastSyncedAt,
  onSync,
}: AdminPanelProps) {
  const { status: adminStatus, error: statusError } = useAdminContentStatus(
    demo.apiUrl,
    lastSyncedAt,
  );
  const listed = demo.catalog.length;

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
                  ? "Allowed — this session can trigger a server refresh"
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

          {statusError !== undefined && (
            <p className="admin-error" role="alert">
              Could not read server status: {statusError}
            </p>
          )}
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
