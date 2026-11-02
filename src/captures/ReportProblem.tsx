import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { reportSession } from "../api/captures";
import { useOnline } from "../pwa/usePwa";
import { CaptureError } from "./CaptureError";
import { invalidateCaptures } from "./useCaptures";

/**
 * "Report a problem" on a remote session (`POST /api/sessions/:id/capture`). The request
 * carries `consent: true` only because the player ticked the box that says what is sent:
 * the full history and its seed, kept 30 days. A local session has nothing to send it to,
 * so the caller renders this only with an API.
 */
export function ReportProblem({
  apiUrl,
  sessionId,
}: {
  apiUrl: string;
  sessionId: string;
}) {
  const { t } = useTranslation("captures");
  const online = useOnline();
  const queryClient = useQueryClient();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<
    { ok: true } | { ok: false; error: unknown }
  >();

  function toggle() {
    setOpen((current) => !current);
    setConsent(false);
    setOutcome(undefined);
  }

  async function send() {
    setSending(true);
    setOutcome(undefined);
    try {
      await reportSession(apiUrl, sessionId);
      setOutcome({ ok: true });
      setConsent(false);
      invalidateCaptures(queryClient);
    } catch (error) {
      setOutcome({ ok: false, error });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="report-problem">
      <button
        type="button"
        className="cabinet-button quiet"
        aria-expanded={open}
        onClick={toggle}
      >
        {t("report.open")}
      </button>
      {open && (
        <form
          className="report-problem-panel"
          aria-labelledby={titleId}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <p className="report-problem-title" id={titleId}>
            {t("report.title")}
          </p>
          <label className="report-problem-consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>{t("report.consent")}</span>
          </label>
          {!online && <p className="account-note">{t("report.offline")}</p>}
          {outcome?.ok === true && (
            <p className="admin-notice" role="status">
              {t("report.sent")}{" "}
              <Link to="/captures">{t("report.sentLink")}</Link>.
            </p>
          )}
          {outcome?.ok === false && <CaptureError error={outcome.error} />}
          <div className="report-problem-actions">
            <button
              type="submit"
              className="cabinet-button primary"
              disabled={!consent || !online || sending}
            >
              {t(sending ? "report.sending" : "report.submit")}
            </button>
            <button type="button" className="cabinet-button" onClick={toggle}>
              {t("report.cancel")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
