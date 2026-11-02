import { request } from "./client";

/** `server/src/captures/store.ts`'s `CaptureSummary`: everything but the fixture. */
export interface CaptureSummary {
  readonly captureId: string;
  readonly playerId: string;
  readonly sessionId: string;
  readonly campaignId: string;
  readonly trigger: "report" | "fault";
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface CaptureConsent {
  readonly faultCapture: boolean;
  readonly consentedAt: string | null;
}

/** A player's report on their own session. `consent` is the ticked checkbox, never a default. */
export const reportSession = (url: string | undefined, sessionId: string) =>
  request<CaptureSummary>(
    url,
    `/api/sessions/${encodeURIComponent(sessionId)}/capture`,
    { method: "POST", body: { consent: true } },
  );

export const getCaptureConsent = (url?: string, signal?: AbortSignal) =>
  request<CaptureConsent>(url, "/api/captures/consent", { signal });

export const setCaptureConsent = (
  url: string | undefined,
  faultCapture: boolean,
) =>
  request<CaptureConsent>(url, "/api/captures/consent", {
    method: "POST",
    body: { faultCapture },
  });

export const getCaptures = (url?: string, signal?: AbortSignal) =>
  request<{ captures: readonly CaptureSummary[] }>(url, "/api/captures", {
    signal,
  });

/** The whole stored capture, fixture and seed included. Never cached by the server. */
export const getCapture = (url: string | undefined, captureId: string) =>
  request<unknown>(url, `/api/captures/${encodeURIComponent(captureId)}`);

export const deleteCapture = (url: string | undefined, captureId: string) =>
  request(url, `/api/captures/${encodeURIComponent(captureId)}`, {
    method: "DELETE",
  });

export const deleteAllCaptures = (url?: string) =>
  request<{ deleted: number }>(url, "/api/captures", { method: "DELETE" });

export const getAdminCaptures = (url?: string, signal?: AbortSignal) =>
  request<{ captures: readonly CaptureSummary[] }>(url, "/api/admin/captures", {
    signal,
  });

/** An admin acting on a player's report; the capture still belongs to the session's owner. */
export const adminCaptureSession = (
  url: string | undefined,
  sessionId: string,
) =>
  request<CaptureSummary>(url, "/api/admin/captures", {
    method: "POST",
    body: { sessionId, consent: true },
  });
