import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getMyContent,
  submitContent,
  requestPublication,
  deleteContent,
  type Submission,
} from "../api/content";
import { useAccount } from "../app/providers/AccountProvider";
/**
 * `/content` -- a signed-in (or guest) player's own submitted campaigns and extensions.
 * Routed under AppShell, which owns theme and account state. The submit form is `AdminPanel.tsx`'s paste/upload/URL flow ported to one
 * owner (CLAUDE.md's "Ingestion UI scope" decision) -- same fields, same "add, then the
 * server refreshes, then report this row's own outcome" shape, against `/api/content`
 * instead of `/api/admin/content/sources`.
 */
import { useRef, useState } from "react";

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

export function MyContent({ apiUrl }: { apiUrl?: string }) {
  const { identity, loading: identityLoading, refreshToken } = useAccount();
  const queryClient = useQueryClient();
  const queryKey = [
    "private",
    apiUrl,
    identity.playerId,
    refreshToken,
    "content",
  ];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getMyContent(apiUrl, signal),
    enabled: Boolean(apiUrl && identity.playerId) && !identityLoading,
  });
  // Shape-guarded, not just null-guarded: `request` hands back whatever parsed, so a
  // malformed `submissions` would otherwise reach `.map` below and take the page down.
  // Annotated rather than inferred -- `Array.isArray` narrows a `readonly T[]` to `any[]`,
  // which would quietly make every `submission` below untyped. The guard is arrayness only;
  // element shape is trusted here exactly as it was before it.
  const submissions: readonly Submission[] = Array.isArray(
    query.data?.submissions,
  )
    ? query.data.submissions
    : [];
  const refetch = () => {
    void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({
      predicate: (q) =>
        q.queryKey[0] === "private" && q.queryKey[4] === "campaigns",
    });
  };

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
    const json = await submitContent(apiUrl, body);
    refetch();
    if (!json?.refresh || json.refresh.ok) {
      return {
        tone: "ok",
        text: "Submitted. It's live now, privately -- you can play it right away, and it's already queued for review. It becomes public if an admin approves it.",
      };
    }
    if (json.source?.lastError) {
      return {
        tone: "error",
        text: `Saved, but it failed to load: ${json.source.lastError}. Fix the content, then delete this row below and submit it again.`,
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
      await requestPublication(apiUrl, id);
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
      await deleteContent(apiUrl, id);
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
    <>
      <section className="archive admin" aria-labelledby="content-title">
        <div className="archive-heading">
          <p className="eyebrow">SUBZERO STORY SYSTEM // AUTHOR SUBMISSIONS</p>
          <h1 id="content-title">My content</h1>
          <p className="admin-note">
            Submit your own campaign or extension. It's playable by you the
            moment it validates, privately, and it goes into the review queue
            automatically — nobody else sees it unless an admin approves it.
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
                                Request another review
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
    </>
  );
}
