import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePwa } from "./usePwa";
import "./pwa.css";

export function PwaStatus({ playing }: { playing: boolean }) {
  const pwa = usePwa();
  const { t } = useTranslation("pwa");
  const [deferred, setDeferred] = useState<ServiceWorker | null>(null);
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      {!pwa.online && (
        <aside className="pwa-status" role="status">
          <strong>{t("offlineTitle")}</strong>
          <p>{t("offlineBody")}</p>
        </aside>
      )}
      {pwa.canInstall && (
        <button className="pwa-install" onClick={() => void pwa.install()}>
          {t("install")}
        </button>
      )}
      {pwa.ios && (
        <details className="pwa-install">
          <summary>{t("install")}</summary>
          <p>{t("ios")}</p>
        </details>
      )}
      {pwa.waiting && deferred === pwa.waiting && (
        <button onClick={() => setDeferred(null)}>{t("showUpdate")}</button>
      )}
      {pwa.waiting && deferred !== pwa.waiting && (
        <aside className="pwa-status" aria-label={t("updateTitle")}>
          <strong>{t("updateTitle")}</strong>
          <p>{t(playing ? "updatePlaying" : "updateBody")}</p>
          {confirm ? (
            <>
              <p>{t("confirm")}</p>
              <button disabled={pwa.applying} onClick={pwa.update}>
                {t("confirmUpdate")}
              </button>
              <button onClick={() => setConfirm(false)}>{t("cancel")}</button>
            </>
          ) : (
            <button disabled={pwa.applying} onClick={() => setConfirm(true)}>
              {t("update")}
            </button>
          )}
          <button
            onClick={() => {
              setDeferred(pwa.waiting);
              setConfirm(false);
            }}
          >
            {t("later")}
          </button>
        </aside>
      )}
      {pwa.problem && (
        <p className="pwa-status" role="alert">
          {t(`errors.${pwa.problem}`)}
        </p>
      )}
    </>
  );
}
