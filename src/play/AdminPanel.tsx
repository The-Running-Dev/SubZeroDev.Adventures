import type { BrowserDemo } from "./composition";

interface AdminPanelProps {
  readonly demo: BrowserDemo;
  readonly syncing: boolean;
  readonly syncError: string | undefined;
  /** Locale-formatted time of the last completed sync, or the initial load. */
  readonly lastSyncedAt: string;
  readonly onSync: () => void;
}

/**
 * An unlisted operator page, reachable only by adding `?admin` to the URL -- the same
 * door a hidden campaign uses (`PlayApp.tsx`'s `?campaign=` effect), and for the same
 * reason: this app has no router, so "a page nothing links to" is a query parameter and
 * a branch, not a route to exclude from a table.
 *
 * "Sync" today means *re-resolve the catalog this browser holds*: `createBrowserDemo()`
 * again, which refetches `/api/campaigns` against a backend or the campaign JSON directly
 * without one. That is worth having on its own, because the catalog is otherwise read
 * once at startup and frozen (`composition.ts`), so a campaign published since this tab
 * opened is invisible until a reload.
 *
 * It is deliberately *not* yet a server-side refresh. The API reads its content once at
 * boot into a registry the whole app closes over (issue #27), so nothing this button can
 * call would make the server re-read anything. When that endpoint exists, this button
 * calls it first and then refetches -- the affordance stays, its reach grows.
 */
export function AdminPanel({
  demo,
  syncing,
  syncError,
  lastSyncedAt,
  onSync,
}: AdminPanelProps) {
  const hidden = demo.catalog.length;

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
          <dd>{hidden}</dd>
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

      <section className="admin-block">
        <h2 className="admin-heading">Catalog</h2>
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Campaign</th>
                <th scope="col">Title</th>
                <th scope="col">Kind</th>
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
                  <td>{campaign.endingCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
