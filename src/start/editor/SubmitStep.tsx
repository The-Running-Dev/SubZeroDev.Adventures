import { submitContent } from "../../api/content";
import { ResourceState } from "../../components/ResourceState";
import { useOnline } from "../../pwa/usePwa";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useState } from "react";
import { useAccount } from "../../app/providers/AccountProvider";
import { toPortableCampaign, type CampaignDraft } from "../draft";

export function SubmitStep({
  draft,
  apiUrl,
  valid,
  onSubmitted,
}: {
  readonly draft: CampaignDraft;
  readonly apiUrl?: string;
  readonly valid: boolean;
  readonly onSubmitted: () => void;
}) {
  const { t } = useTranslation("creator");
  const online = useOnline();
  const queryClient = useQueryClient();
  const { identity, loading } = useAccount();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{
    readonly tone: "ok" | "error";
    readonly key?: string;
    readonly error?: unknown;
  }>();

  const signedIn = !loading && identity.kind !== "anonymous";

  async function submit(): Promise<void> {
    setBusy(true);
    setOutcome(undefined);
    try {
      // The same request `MyContent.tsx`'s paste form sends. Nothing about an authored draft
      // makes it a different kind of submission, so it does not get a different route: it
      // inherits the submission tier's fail-open quarantine and the review queue as they are.
      const body = await submitContent(apiUrl, {
        kind: "pasted",
        label: draft.title || draft.id,
        payload: toPortableCampaign(draft),
      });
      void queryClient.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === "private" &&
          ["content", "campaigns"].includes(String(q.queryKey[4])),
      });
      if (body?.source?.lastError) {
        setOutcome({
          tone: "error",
          key: "content:loadFailed",
        });
        return;
      }
      setOutcome({
        tone: "ok",
        key: "content:saved",
      });
      onSubmitted();
    } catch (error) {
      setOutcome({
        tone: "error",
        error,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gs-form">
      <p className="gs-prose">
        {t("submitIntro")} <Link to="/content">{t("myContent")}</Link>.
      </p>

      {!apiUrl && <p className="gs-note">{t("noServer")}</p>}
      {apiUrl && loading && <p className="gs-note">{t("checking")}</p>}
      {apiUrl && !loading && !signedIn && (
        <p className="gs-note">{t("signIn")}</p>
      )}
      {!valid && <p className="gs-note">{t("validateFirst")}</p>}

      <button
        type="button"
        className="gs-btn gs-btn-primary"
        disabled={!online || !apiUrl || !signedIn || !valid || busy}
        onClick={() => void submit()}
      >
        {busy ? t("submitting") : t("submitAction")}
      </button>

      {!online && <ResourceState state="offline" />}
      {outcome?.error !== undefined && (
        <ResourceState state="error" error={outcome.error} />
      )}
      {outcome?.key && (
        <p
          className={outcome.tone === "error" ? "gs-error" : "gs-note"}
          role={outcome.tone === "error" ? "alert" : "status"}
        >
          {t(outcome.key)}
        </p>
      )}

      <details className="gs-json">
        <summary>{t("file")}</summary>
        <pre>{JSON.stringify(toPortableCampaign(draft), null, 2)}</pre>
      </details>
    </div>
  );
}
