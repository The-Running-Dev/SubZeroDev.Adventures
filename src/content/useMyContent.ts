import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getMyContent,
  submitContent,
  requestPublication,
  deleteContent,
  type Submission,
} from "../api/content";
import { useAccount } from "../app/providers/AccountProvider";
import { useOnline } from "../pwa/usePwa";
export interface Outcome {
  readonly tone: "ok" | "warn" | "error";
  readonly key?: string;
  readonly error?: unknown;
}
export function useMyContent(apiUrl?: string) {
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
  return {
    online,
    identity,
    identityLoading,
    refreshToken,
    queryClient,
    queryKey,
    query,
    submissions,
    refetch,
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
    busyId,
    setBusyId,
    rowError,
    setRowError,
    ready,
    handleAddUrl,
    handleAddPaste,
    handleAddFile,
    handleDelete,
    handleRequestPublish,
  };
}
