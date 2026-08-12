/**
 * `/content` -- a signed-in (or guest) player's own submitted campaigns and extensions.
 * Standalone top-level page, same shape as `OwnProfile.tsx`/`Ranking.tsx`: `apiUrl` read
 * once by `main.tsx` and passed down as a prop, its own theme state for the shared
 * `Header`. The submit form is `AdminPanel.tsx`'s paste/upload/URL flow ported to one
 * owner (CLAUDE.md's "Ingestion UI scope" decision) -- same fields, same "add, then the
 * server refreshes, then report this row's own outcome" shape, against `/api/content`
 * instead of `/api/admin/content/sources`.
 */
import { useEffect, useRef, useState } from "react";
import { Header } from "../Header";
import { AccountPanel } from "../play/AccountPanel";
import {
  consumeAuthError,
  useAdminAccess,
  useIdentity,
} from "../play/identity";
import {
  applyTheme,
  DEFAULT_THEME,
  readStoredTheme,
  storeTheme,
  type ThemeId,
} from "../theme";

type SubmissionStatus = "pending" | "approved" | "rejected";
type SubmissionVisibility = "private" | "public";

interface Submission {
  readonly id: string;
  readonly kind: "url" | "pasted";
  readonly label: string;
  readonly url?: string;
  readonly lastSyncedAt?: string;
  readonly lastError?: string;
  readonly campaignCount?: number;
  readonly extensionCount?: number;
  readonly status: SubmissionStatus;
  readonly visibility: SubmissionVisibility;
  readonly reviewNote?: string;
  readonly quarantineReason?: string;
}

interface Outcome {
  readonly tone: "ok" | "warn" | "error";
  readonly text: string;
}

function OutcomeNote({ outcome }: { readonly outcome: Outcome }) {
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

function statusLabel(submission: Submission): string {
  if (submission.visibility === "public") return "Public";
  if (submission.status === "pending") return "Private — pending review";
  if (submission.status === "rejected") return "Private — not approved";
  return "Private";
}

function useMySubmissions(
  apiUrl: string | undefined,
  refetchKey: string,
): { submissions: readonly Submission[]; refetch: () => void } {
  const [submissions, setSubmissions] = useState<readonly Submission[]>([]);
  const [token, setToken] = useState(0);

  useEffect(() => {
    if (!apiUrl) return;
    let cancelled = false;
    fetch(`${apiUrl}/api/content/mine`, { credentials: "include" })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{ submissions: Submission[] }>)
          : { submissions: [] },
      )
      .then((body) => {
        if (!cancelled)
          setSubmissions(
            Array.isArray(body.submissions) ? body.submissions : [],
          );
      })
      .catch(() => {
        if (!cancelled) setSubmissions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [apiUrl, refetchKey, token]);

  return { submissions, refetch: () => setToken((t) => t + 1) };
}

export function MyContent({ apiUrl }: { apiUrl?: string }) {
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);
  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);
  function changeTheme(id: ThemeId): void {
    setTheme(id);
    applyTheme(id);
    storeTheme(id);
  }

  const [identityRefreshToken, setIdentityRefreshToken] = useState(0);
  const { identity, loading: identityLoading } = useIdentity(
    apiUrl,
    identityRefreshToken,
  );
  const { isAdmin } = useAdminAccess(apiUrl, identity.playerId);
  const [authError] = useState(() => consumeAuthError());

  const [refreshToken, setRefreshToken] = useState(0);
  const { submissions, refetch } = useMySubmissions(
    apiUrl,
    `${identity.playerId ?? ""}:${refreshToken}`,
  );

  const [urlLabel, setUrlLabel] = useState("");
  const [urlValue, setUrlValue] = useState("");
  const [addingUrl, setAddingUrl] = useState(false);
  const [urlOutcome, setUrlOutcome] = useState<Outcome>();

  const [pasteText, setPasteText] = useState("");
  const [addingPaste, setAddingPaste] = useState(false);
  const [pasteOutcome, setPasteOutcome] = useState<Outcome>();

  const fileInput = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File>();
  const [addingFile, setAddingFile] = useState(false);
  const [fileOutcome, setFileOutcome] = useState<Outcome>();

  const [busyId, setBusyId] = useState<string>();
  const [rowError, setRowError] = useState<{ id: string; text: string }>();

  const ready =
    Boolean(apiUrl) && !identityLoading && identity.kind !== "anonymous";

  /** Mirrors `AdminPanel.tsx`'s `postSource` -- a 201 always means the row exists, so
   *  everything from here on is a report about a source that is already saved. */
  async function postSubmission(body: unknown): Promise<Outcome> {
    const response = await fetch(`${apiUrl}/api/content`, {
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
    setRefreshToken((t) => t + 1);
    if (!json?.refresh || json.refresh.ok) {
      return {
        tone: "ok",
        text: "Submitted. It's live now, privately -- you can play it right away. Request review below to make it public.",
      };
    }
    if (json.source?.lastError) {
      return {
        tone: "error",
        text: `Saved, but it failed to load: ${json.source.lastError}. Fix the content and try again, or edit it below.`,
      };
    }
    return {
      tone: "warn",
      text: "Saved, and it loaded cleanly -- but the catalog refresh itself failed for an unrelated reason. It will take effect once that clears.",
    };
  }

  async function handleAddUrl(): Promise<void> {
    setAddingUrl(true);
    setUrlOutcome(undefined);
    try {
      const outcome = await postSubmission({
        kind: "url",
        label: urlLabel,
        url: urlValue,
      });
      setUrlLabel("");
      setUrlValue("");
      setUrlOutcome(outcome);
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
      const outcome = await postSubmission({ kind: "pasted", payload });
      setPasteText("");
      setPasteOutcome(outcome);
    } catch (error) {
      setPasteOutcome({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setAddingPaste(false);
    }
  }

  async function handleAddFile(): Promise<void> {
    if (!selectedFile) return;
    setAddingFile(true);
    setFileOutcome(undefined);
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(await selectedFile.text());
      } catch {
        throw new Error(`${selectedFile.name} isn't valid JSON`);
      }
      const outcome = await postSubmission({ kind: "pasted", payload });
      setSelectedFile(undefined);
      if (fileInput.current) fileInput.current.value = "";
      setFileOutcome(outcome);
    } catch (error) {
      setFileOutcome({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setAddingFile(false);
    }
  }

  async function handleRequestPublish(id: string): Promise<void> {
    setBusyId(id);
    setRowError(undefined);
    try {
      const response = await fetch(`${apiUrl}/api/content/${id}/publish`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) throw new Error(`request failed: ${response.status}`);
      refetch();
    } catch (error) {
      setRowError({
        id,
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyId(undefined);
    }
  }

  async function handleDelete(id: string): Promise<void> {
    setBusyId(id);
    setRowError(undefined);
    try {
      const response = await fetch(`${apiUrl}/api/content/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) throw new Error(`request failed: ${response.status}`);
      refetch();
    } catch (error) {
      setRowError({
        id,
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <main className="play-main">
      <Header current="content" theme={theme} onThemeChange={changeTheme}>
        {apiUrl && (
          <AccountPanel
            apiUrl={apiUrl}
            identity={identity}
            loading={identityLoading}
            authError={authError}
            onChanged={() => setIdentityRefreshToken((token) => token + 1)}
            isAdmin={isAdmin}
            profileAvailable={true}
          />
        )}
      </Header>
      <section className="archive admin" aria-labelledby="content-title">
        <div className="archive-heading">
          <p className="eyebrow">SUBZERO STORY SYSTEM // AUTHOR SUBMISSIONS</p>
          <h1 id="content-title">My content</h1>
          <p className="admin-note">
            Submit your own campaign or extension. It's playable by you the
            moment it validates, privately — nobody else sees it until you
            request review and an admin approves it.
          </p>

          {!apiUrl && (
            <p className="profile-unavailable">
              Content submission isn't available on this build.
            </p>
          )}
          {apiUrl && identityLoading && (
            <p className="profile-unavailable" role="status">
              Loading your record…
            </p>
          )}
          {apiUrl && !identityLoading && identity.kind === "anonymous" && (
            <p className="profile-unavailable">
              Play a story or sign in first -- there's nothing on record yet.
            </p>
          )}
        </div>

        {ready && (
          <>
            <section className="admin-block">
              <h2 className="admin-heading">Your submissions</h2>
              <div className="admin-table-scroll">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th scope="col">Label</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Status</th>
                      <th scope="col">Campaigns</th>
                      <th scope="col">Issue</th>
                      <th scope="col" />
                    </tr>
                  </thead>
                  <tbody>
                    {submissions.map((submission) => (
                      <tr key={submission.id}>
                        <td>{submission.label}</td>
                        <td>{submission.kind}</td>
                        <td>{statusLabel(submission)}</td>
                        <td>{submission.campaignCount ?? "—"}</td>
                        <td>
                          {submission.lastError ? (
                            <span
                              className="admin-cell-error-icon"
                              title={submission.lastError}
                              role="img"
                              aria-label={`Error: ${submission.lastError}`}
                            >
                              ⚠
                            </span>
                          ) : submission.quarantineReason ? (
                            <span
                              className="admin-cell-error-icon"
                              title={submission.quarantineReason}
                              role="img"
                              aria-label={`Not published: ${submission.quarantineReason}`}
                            >
                              ⚠
                            </span>
                          ) : submission.reviewNote ? (
                            <span title={submission.reviewNote}>
                              {submission.reviewNote}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>
                          {submission.visibility === "private" &&
                            submission.status !== "pending" && (
                              <button
                                type="button"
                                className="admin-sync admin-row-action"
                                onClick={() =>
                                  void handleRequestPublish(submission.id)
                                }
                                disabled={busyId === submission.id}
                              >
                                Request review
                              </button>
                            )}
                          <button
                            type="button"
                            className="admin-remove admin-row-action"
                            onClick={() => void handleDelete(submission.id)}
                            disabled={busyId === submission.id}
                          >
                            {busyId === submission.id ? "Removing…" : "Delete"}
                          </button>
                          {rowError?.id === submission.id && (
                            <p className="admin-cell-error-note" role="alert">
                              {rowError.text}
                            </p>
                          )}
                        </td>
                      </tr>
                    ))}
                    {submissions.length === 0 && (
                      <tr>
                        <td colSpan={6}>Nothing submitted yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="admin-block">
              <h2 className="admin-heading">Submit</h2>

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
                    {addingUrl ? "Adding…" : "Add"}
                  </button>
                </div>
                {urlOutcome && <OutcomeNote outcome={urlOutcome} />}
              </div>

              <div className="admin-form">
                <h3 className="admin-subheading">
                  Paste a campaign or extension
                </h3>
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
                    {addingPaste ? "Adding…" : "Add"}
                  </button>
                </div>
                {pasteOutcome && <OutcomeNote outcome={pasteOutcome} />}
              </div>

              <div className="admin-form">
                <h3 className="admin-subheading">
                  Upload a campaign or extension JSON
                </h3>
                <div className="admin-form-row">
                  <label
                    className="admin-file-label"
                    htmlFor="content-json-file"
                  >
                    JSON file
                  </label>
                  <input
                    ref={fileInput}
                    id="content-json-file"
                    type="file"
                    accept="application/json,.json"
                    onChange={(event) => {
                      setSelectedFile(event.target.files?.[0]);
                      setFileOutcome(undefined);
                    }}
                    disabled={addingFile}
                  />
                  <button
                    type="button"
                    className="admin-sync"
                    onClick={() => void handleAddFile()}
                    disabled={!selectedFile || addingFile}
                  >
                    {addingFile ? "Uploading…" : "Upload"}
                  </button>
                </div>
                {selectedFile && (
                  <p className="admin-file-name" role="status">
                    Selected: {selectedFile.name}
                  </p>
                )}
                {fileOutcome && <OutcomeNote outcome={fileOutcome} />}
              </div>
            </section>
          </>
        )}
      </section>
    </main>
  );
}
