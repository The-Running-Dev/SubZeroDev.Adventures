import { useTranslation } from "react-i18next";
import { ApiError } from "../../api/client";
import { ResourceState } from "../../components/ResourceState";
import type { AddOutcome } from "./types";
export function shortPreview(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function AddOutcomeNote({ outcome }: { readonly outcome: AddOutcome }) {
  const { t } = useTranslation("admin");
  if (outcome.error)
    return outcome.error instanceof ApiError && outcome.error.status === 403 ? (
      <p role="alert">{t("forbidden")}</p>
    ) : (
      <ResourceState state="error" error={outcome.error} />
    );
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
      {t(outcome.key ?? "sourceFailed")}
    </p>
  );
}
