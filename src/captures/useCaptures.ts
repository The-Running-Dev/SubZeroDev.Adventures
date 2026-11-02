import { useState } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  adminCaptureSession,
  deleteAllCaptures,
  deleteCapture,
  getAdminCaptures,
  getCapture,
  getCaptureConsent,
  getCaptures,
  setCaptureConsent,
  type CaptureSummary,
} from "../api/captures";
import { useAccount } from "../app/providers/AccountProvider";
import { useOnline } from "../pwa/usePwa";

/** Both capture lists, the player's and the admin's, after anything that changes either. */
export function invalidateCaptures(queryClient: QueryClient) {
  void queryClient.invalidateQueries({
    predicate: (q) =>
      q.queryKey[0] === "private" &&
      (q.queryKey[4] === "captures" || q.queryKey[4] === "admin-captures"),
  });
}

/** Hands the fixture to the browser as a file. It is never kept in the query cache. */
export async function downloadCapture(
  apiUrl: string | undefined,
  captureId: string,
): Promise<void> {
  const body = await getCapture(apiUrl, captureId);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `capture-${captureId}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Arrayness only, as `useMyContent` guards `submissions`: a malformed body must not reach `.map`.
function capturesOf(data: { captures?: unknown } | undefined) {
  return Array.isArray(data?.captures)
    ? (data.captures as readonly CaptureSummary[])
    : [];
}

/** Download and delete for one row at a time, shared by the player's list and the admin's. */
function useRowActions(apiUrl: string | undefined) {
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string>();
  const [rowError, setRowError] = useState<{ id: string; error: unknown }>();
  async function run(id: string, action: () => Promise<unknown>) {
    setBusyId(id);
    setRowError(undefined);
    try {
      await action();
    } catch (error) {
      setRowError({ id, error });
    } finally {
      setBusyId(undefined);
    }
  }
  return {
    busyId,
    rowError,
    handleDownload: (id: string) => run(id, () => downloadCapture(apiUrl, id)),
    handleDelete: (id: string) =>
      run(id, async () => {
        await deleteCapture(apiUrl, id);
        invalidateCaptures(queryClient);
      }),
  };
}

export function useMyCaptures(apiUrl?: string) {
  const online = useOnline();
  const { identity, loading: identityLoading, refreshToken } = useAccount();
  const queryClient = useQueryClient();
  const ready =
    Boolean(apiUrl) && !identityLoading && identity.kind !== "anonymous";
  const query = useQuery({
    queryKey: ["private", apiUrl, identity.playerId, refreshToken, "captures"],
    queryFn: ({ signal }) => getCaptures(apiUrl, signal),
    enabled: ready,
  });
  const rows = useRowActions(apiUrl);
  const [deletingAll, setDeletingAll] = useState(false);
  const [deleteAllError, setDeleteAllError] = useState<unknown>();
  async function handleDeleteAll(): Promise<void> {
    setDeletingAll(true);
    setDeleteAllError(undefined);
    try {
      await deleteAllCaptures(apiUrl);
      invalidateCaptures(queryClient);
    } catch (error) {
      setDeleteAllError(error);
    } finally {
      setDeletingAll(false);
    }
  }
  return {
    online,
    identity,
    identityLoading,
    ready,
    query,
    captures: capturesOf(query.data),
    ...rows,
    deletingAll,
    deleteAllError,
    handleDeleteAll,
  };
}

export function useCaptureConsent(apiUrl?: string) {
  const { identity, loading: identityLoading, refreshToken } = useAccount();
  const queryClient = useQueryClient();
  const queryKey = [
    "private",
    apiUrl,
    identity.playerId,
    refreshToken,
    "capture-consent",
  ];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getCaptureConsent(apiUrl, signal),
    enabled:
      Boolean(apiUrl) && !identityLoading && identity.kind !== "anonymous",
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>();
  async function setFaultCapture(next: boolean): Promise<void> {
    setSaving(true);
    setSaveError(undefined);
    try {
      queryClient.setQueryData(queryKey, await setCaptureConsent(apiUrl, next));
    } catch (error) {
      setSaveError(error);
    } finally {
      setSaving(false);
    }
  }
  return { query, saving, saveError, setFaultCapture };
}

export function useAdminCaptures(apiUrl: string | undefined) {
  const { identity, refreshToken } = useAccount();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [
      "private",
      apiUrl,
      identity.playerId,
      refreshToken,
      "admin-captures",
    ],
    queryFn: ({ signal }) => getAdminCaptures(apiUrl, signal),
    enabled: Boolean(apiUrl),
  });
  const rows = useRowActions(apiUrl);
  const [capturing, setCapturing] = useState(false);
  const [captureOutcome, setCaptureOutcome] = useState<
    { ok: true; captureId: string } | { ok: false; error: unknown }
  >();
  async function handleCapture(sessionId: string): Promise<boolean> {
    setCapturing(true);
    setCaptureOutcome(undefined);
    try {
      const summary = await adminCaptureSession(apiUrl, sessionId);
      setCaptureOutcome({ ok: true, captureId: summary.captureId });
      invalidateCaptures(queryClient);
      return true;
    } catch (error) {
      setCaptureOutcome({ ok: false, error });
      return false;
    } finally {
      setCapturing(false);
    }
  }
  return {
    query,
    captures: capturesOf(query.data),
    ...rows,
    capturing,
    captureOutcome,
    handleCapture,
  };
}
