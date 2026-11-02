import { useTranslation } from "react-i18next";
import { ApiError } from "../api/client";

/**
 * A capture route's refusal, by the server's own code (`routes/session.ts`'s `ERROR_STATUS`
 * plus `routes/captures.ts`'s `consent_required`/`unknown_capture`). An unrecognized code
 * falls back to a generic line rather than the server's English.
 */
export function CaptureError({ error }: { error: unknown }) {
  const { t, i18n } = useTranslation("captures");
  const code = error instanceof ApiError ? error.code : undefined;
  const key = code && i18n.exists(`captures:errors.${code}`) ? code : "generic";
  return (
    <p className="admin-error" role="alert">
      {t(`errors.${key}`)}
    </p>
  );
}
