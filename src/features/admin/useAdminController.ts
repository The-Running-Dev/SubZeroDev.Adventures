import { ApiError, request } from "../../api/client";
import { useOnline } from "../../pwa/usePwa";
import type { SubmissionResult } from "../../api/content";
import { useRef, useState } from "react";
import type { AdminPanelProps, AddOutcome } from "./types";
import { useAdminContentStatus, useSubmissionQueue } from "./useAdminData";
export function useAdminController({
  demo,
  lastSyncedAt,
  onSync,
}: AdminPanelProps) {
  const [sourcesToken, setSourcesToken] = useState(0);
  const {
    status: adminStatus,
    error: statusError,
    refetch: refetchStatus,
    loading: statusLoading,
  } = useAdminContentStatus(demo.apiUrl, `${lastSyncedAt}:${sourcesToken}`);
  const listed = demo.catalog.length;
  const online = useOnline();
  const canManageSources = online && adminStatus?.isAdmin === true;
  const [urlLabel, setUrlLabel] = useState("");
  const [urlValue, setUrlValue] = useState("");
  const [addingUrl, setAddingUrl] = useState(false);
  const [urlOutcome, setUrlOutcome] = useState<AddOutcome>();
  const [pasteText, setPasteText] = useState("");
  const [addingPaste, setAddingPaste] = useState(false);
  const [pasteOutcome, setPasteOutcome] = useState<AddOutcome>();
  const fileInput = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File>();
  const [addingFile, setAddingFile] = useState(false);
  const [fileOutcome, setFileOutcome] = useState<AddOutcome>();
  const {
    submissions: pendingSubmissions,
    error: queueError,
    refetch: refetchQueue,
    loading: queueLoading,
  } = useSubmissionQueue(demo.apiUrl, sourcesToken.toString());
  const [reviewBusyId, setReviewBusyId] = useState<string>();
  const [reviewError, setReviewError] = useState<{
    id: string;
    error: unknown;
  }>();
  async function review(
    id: string,
    decision: "approve" | "reject",
  ): Promise<void> {
    setReviewBusyId(id);
    setReviewError(undefined);
    try {
      await request(
        demo.apiUrl,
        `/api/admin/content/submissions/${encodeURIComponent(id)}/${decision}`,
        { method: "POST" },
      );
      refetchQueue();
      setSourcesToken((t) => t + 1);
      onSync();
    } catch (error) {
      setReviewError({
        id,
        error,
      });
    } finally {
      setReviewBusyId(undefined);
    }
  }
  const [removingId, setRemovingId] = useState<string>();
  const [removeError, setRemoveError] = useState<{
    readonly id: string;
    readonly error: unknown;
  }>();
  async function postSource(body: unknown): Promise<AddOutcome> {
    let json: SubmissionResult;
    try {
      json = await request<SubmissionResult>(
        demo.apiUrl,
        "/api/admin/content/sources",
        { method: "POST", body },
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) refetchStatus();
      throw error;
    }
    if (!json?.refresh || json.refresh.ok) {
      return {
        tone: "ok",
        key: "added",
      };
    }
    if (json.source?.lastError) {
      return {
        tone: "error",
        key: "sourceFailed",
      };
    }
    // The added source loaded cleanly and something else didn't. Saying so is the point:
    // a refresh only publishes when every source succeeds, so this row is fine and simply
    // isn't live yet.
    return {
      tone: "warn",
      key: "refreshFailed",
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
        setPasteOutcome({ tone: "error", key: "content:invalidJson" });
        return;
      }
      const outcome = await postSource({ kind: "pasted", payload });
      setPasteText("");
      setPasteOutcome(outcome);
      setSourcesToken((t) => t + 1);
      if (outcome.tone === "ok") onSync();
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
        setFileOutcome({ tone: "error", key: "content:invalidJson" });
        return;
      }
      const outcome = await postSource({ kind: "pasted", payload });
      setSelectedFile(undefined);
      if (fileInput.current) fileInput.current.value = "";
      setFileOutcome(outcome);
      setSourcesToken((t) => t + 1);
      if (outcome.tone === "ok") onSync();
    } catch (error) {
      setFileOutcome({
        tone: "error",
        error,
      });
    } finally {
      setAddingFile(false);
    }
  }
  async function handleRemove(id: string): Promise<void> {
    if (!demo.apiUrl) return;
    setRemovingId(id);
    setRemoveError(undefined);
    try {
      await request(
        demo.apiUrl,
        `/api/admin/content/sources/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      refetchStatus();
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) refetchStatus();
      setRemoveError({
        id,
        error,
      });
    } finally {
      setRemovingId(undefined);
    }
  }
  return {
    statusLoading,
    queueLoading,
    online,
    sourcesToken,
    setSourcesToken,
    adminStatus,
    statusError,
    refetchStatus,
    listed,
    canManageSources,
    urlLabel,
    setUrlLabel,
    urlValue,
    setUrlValue,
    addingUrl,
    setAddingUrl,
    urlOutcome,
    setUrlOutcome,
    pasteText,
    setPasteText,
    addingPaste,
    setAddingPaste,
    pasteOutcome,
    setPasteOutcome,
    fileInput,
    selectedFile,
    setSelectedFile,
    addingFile,
    setAddingFile,
    fileOutcome,
    setFileOutcome,
    pendingSubmissions,
    queueError,
    refetchQueue,
    reviewBusyId,
    setReviewBusyId,
    reviewError,
    setReviewError,
    removingId,
    setRemovingId,
    removeError,
    setRemoveError,
    handleAddUrl,
    handleAddPaste,
    handleAddFile,
    handleRemove,
    review,
  };
}
