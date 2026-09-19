import { useTranslation } from "react-i18next";

export function ArrivalReceipt({ arrivalChoice }: { arrivalChoice?: string }) {
  const { t } = useTranslation("play");
  return (
    <div className="arrival-receipt" role="status">
      {arrivalChoice ? (
        <>
          <span>{t("lastCommand")}</span>
          <strong>{arrivalChoice}</strong>
          <span className="arrival-link">{t("accepted")}</span>
        </>
      ) : (
        <strong>{t("loaded")}</strong>
      )}
    </div>
  );
}
