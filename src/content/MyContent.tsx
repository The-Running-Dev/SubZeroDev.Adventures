import { useTranslation } from "react-i18next";
import { ResourceState } from "../components/ResourceState";
import { useOnline } from "../pwa/usePwa";
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
  readonly key?: string;
  readonly error?: unknown;
}

function OutcomeNote({ outcome }: { readonly outcome: Outcome }) {
  const { t } = useTranslation("content");
  if (outcome.error)
    return <ResourceState state="error" error={outcome.error} />;
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
      {t(outcome.key ?? "loadFailed")}
    </p>
  );
}

function statusLabel(submission: Submission): string {
  if (submission.visibility === "public") return "public";
  if (submission.status === "pending") return "pending";
  if (submission.status === "rejected") return "rejected";
  return "private";
}

export function MyContent({ apiUrl }: { apiUrl?: string }) {
  const { t } = useTranslation("content");
  const online = useOnline();
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
  const [rowError, setRowError] = useState<{ id: string; error: unknown }>();

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
        key: "saved",
      };
    }
    if (json.source?.lastError) {
      return {
        tone: "error",
        key: "loadFailed",
      };
    }
    return {
      tone: "warn",
      key: "refreshFailed",
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
        error,
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
        setPasteOutcome({ tone: "error", key: "invalidJson" });
        return;
      }
      const outcome = await postSubmission({ kind: "pasted", payload });
      setPasteText("");
      setPasteOutcome(outcome);
    } catch (error) {
      setPasteOutcome({
        tone: "error",
        error,
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
        setFileOutcome({ tone: "error", key: "invalidJson" });
        return;
      }
      const outcome = await postSubmission({ kind: "pasted", payload });
      setSelectedFile(undefined);
      if (fileInput.current) fileInput.current.value = "";
      setFileOutcome(outcome);
    } catch (error) {
      setFileOutcome({
        tone: "error",
        error,
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
        error,
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
        error,
      });
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <>
      <section
        className="feature-page archive admin"
        aria-labelledby="content-title"
      >
        <div className="archive-heading">
          <p className="eyebrow">{t("eyebrow")}</p>
          <h1 id="content-title">{t("title")}</h1>
          <p className="admin-note">{t("intro")}</p>

          {!apiUrl && <p className="profile-unavailable">{t("unavailable")}</p>}
          {apiUrl && identityLoading && (
            <p className="profile-unavailable" role="status">
              {t("loading")}
            </p>
          )}
          {apiUrl && !identityLoading && identity.kind === "anonymous" && (
            <p className="profile-unavailable">{t("anonymous")}</p>
          )}
        </div>

        {ready && !online && <ResourceState state="offline" />}
        {ready && query.isPending && <ResourceState state="loading" />}
        {ready && query.isError && (
          <ResourceState
            state="error"
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        )}
        {ready && !query.isPending && !query.isError && (
          <>
            <section className="admin-block">
              <h2 className="admin-heading">{t("submissions")}</h2>
              <div className="admin-table-scroll">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("label")}</th>
                      <th scope="col">{t("kind")}</th>
                      <th scope="col">{t("status")}</th>
                      <th scope="col">{t("campaigns")}</th>
                      <th scope="col">{t("issue")}</th>
                      <th scope="col" />
                    </tr>
                  </thead>
                  <tbody>
                    {submissions.map((submission) => (
                      <tr key={submission.id}>
                        <td>{submission.label}</td>
                        <td>{t(submission.kind)}</td>
                        <td>{t(statusLabel(submission))}</td>
                        <td>{submission.campaignCount ?? "—"}</td>
                        <td>
                          {submission.lastError ||
                          submission.quarantineReason ? (
                            <details>
                              <summary>
                                {t(
                                  submission.lastError
                                    ? "loadIssue"
                                    : "quarantined",
                                )}
                              </summary>
                              <pre className="content-diagnostic">
                                {submission.lastError ??
                                  submission.quarantineReason}
                              </pre>
                            </details>
                          ) : (
                            (submission.reviewNote ?? "—")
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
                                disabled={!online || busyId === submission.id}
                              >
                                {t("review")}
                              </button>
                            )}
                          <button
                            type="button"
                            className="admin-remove admin-row-action"
                            onClick={() => void handleDelete(submission.id)}
                            disabled={!online || busyId === submission.id}
                          >
                            {busyId === submission.id
                              ? t("removing")
                              : t("delete")}
                          </button>
                          {rowError?.id === submission.id && (
                            <ResourceState
                              state="error"
                              error={rowError.error}
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                    {submissions.length === 0 && (
                      <tr>
                        <td colSpan={6}>{t("empty")}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="admin-block">
              <h2 className="admin-heading">{t("submit")}</h2>

              <div className="admin-form">
                <h3 className="admin-subheading">{t("urlSource")}</h3>
                <div className="admin-form-row">
                  <input
                    type="text"
                    aria-label={t("label")}
                    placeholder={t("label")}
                    value={urlLabel}
                    onChange={(event) => setUrlLabel(event.target.value)}
                  />
                  <input
                    type="text"
                    aria-label={t("sourceUrl")}
                    placeholder="https://…/campaigns/"
                    value={urlValue}
                    onChange={(event) => setUrlValue(event.target.value)}
                  />
                  <button
                    type="button"
                    className="admin-sync"
                    onClick={() => void handleAddUrl()}
                    disabled={!online || addingUrl || !urlLabel || !urlValue}
                  >
                    {addingUrl ? t("adding") : t("add")}
                  </button>
                </div>
                {urlOutcome && <OutcomeNote outcome={urlOutcome} />}
              </div>

              <div className="admin-form">
                <h3 className="admin-subheading">{t("paste")}</h3>
                <textarea
                  className="admin-paste"
                  aria-label={t("paste")}
                  placeholder={t("pasteHint")}
                  value={pasteText}
                  onChange={(event) => setPasteText(event.target.value)}
                  rows={6}
                />
                <div className="admin-form-row">
                  <button
                    type="button"
                    className="admin-sync"
                    onClick={() => void handleAddPaste()}
                    disabled={!online || addingPaste || !pasteText.trim()}
                  >
                    {addingPaste ? t("adding") : t("add")}
                  </button>
                </div>
                {pasteOutcome && <OutcomeNote outcome={pasteOutcome} />}
              </div>

              <div className="admin-form">
                <h3 className="admin-subheading">{t("uploadTitle")}</h3>
                <div className="admin-form-row">
                  <label
                    className="admin-file-label"
                    htmlFor="content-json-file"
                  >
                    {t("file")}
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
                    disabled={!online || addingFile}
                  />
                  <button
                    type="button"
                    className="admin-sync"
                    onClick={() => void handleAddFile()}
                    disabled={!online || !selectedFile || addingFile}
                  >
                    {addingFile ? t("uploading") : t("upload")}
                  </button>
                </div>
                {selectedFile && (
                  <p className="admin-file-name" role="status">
                    {t("selected", { name: selectedFile.name })}
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
