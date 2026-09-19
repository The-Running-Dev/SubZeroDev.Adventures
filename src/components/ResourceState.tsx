import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { ApiError } from "../api/client";

/** Common states for the feature-screen migrations in PRs 5–9. */
export function ResourceState({
  state,
  error,
  onRetry,
}: {
  state:
    "loading" | "empty" | "unauthorized" | "offline" | "unavailable" | "error";
  error?: unknown;
  onRetry?: () => void;
}) {
  const { t, i18n } = useTranslation("common");
  const code =
    error instanceof ApiError
      ? error.status === 401
        ? "unauthorized"
        : error.status === 403
          ? "forbidden"
          : error.status === 404
            ? "not_found"
            : error.code
      : "request_failed";
  const key =
    state === "error"
      ? `errors.${i18n.exists(`errors.${code}`) ? code : "request_failed"}`
      : state;
  return (
    <div className="app-state" role={state === "error" ? "alert" : "status"}>
      <p>{t(key)}</p>
      {onRetry && <Button onClick={onRetry}>{t("retry")}</Button>}
    </div>
  );
}
