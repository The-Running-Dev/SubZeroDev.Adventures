import { useTranslation } from "react-i18next";
import { ResourceState } from "../components/ResourceState";
import type { Outcome } from "./useMyContent";
export function OutcomeNote({ outcome }: { readonly outcome: Outcome }) {
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
