import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { getCampaigns } from "../api/campaigns";
import { ApiError, request } from "../api/client";
import { ResourceState } from "../components/ResourceState";
import { SceneRegion } from "../features/play/SceneRegion";
import { ActionDeck } from "../features/play/ActionDeck";
import { usePlayerShell } from "../app/playerShell";
import { useTheme } from "../app/providers/ThemeProvider";
import { useOfflineScope } from "./identity";
import {
  records,
  removeRecord,
  type LocalRun,
  type SavedDownload,
} from "./database";
import {
  advanceLocal,
  downloadCampaign,
  recover,
  startLocal,
  synchronize,
} from "./adapter";
import type { Frame } from "../../shared/offline/protocol";
import "../play/play.css";
import "./offline.css";
export default function OfflinePage() {
  const identity = useOfflineScope();
  if (!identity.scope)
    return (
      <ResourceState
        state={
          identity.identityError
            ? "error"
            : identity.online
              ? "loading"
              : "offline"
        }
        error={identity.identityError}
      />
    );
  return (
    <OfflineContent key={identity.scope} {...identity} scope={identity.scope} />
  );
}
function OfflineContent({
  scope,
  member,
  online,
  apiUrl,
  refreshToken,
}: ReturnType<typeof useOfflineScope> & { scope: string }) {
  const { t } = useTranslation("offline");
  const { theme } = useTheme();
  const { runId } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const [downloads, setDownloads] = useState<SavedDownload[]>([]);
  const [runs, setRuns] = useState<LocalRun[]>([]);
  const [frame, setFrame] = useState<Frame>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [progress, setProgress] = useState(0);
  const [deleting, setDeleting] = useState<{
    store: "runs" | "downloads";
    key: string;
  }>();
  const [archive, setArchive] =
    useState<{ localRunId: string; blob: string }[]>();
  const region = useRef<HTMLElement>(null);
  const active = runs.find((run) => run.id === runId);
  usePlayerShell({
    active: Boolean(active),
    title: active?.download.bundle.portable.catalog.title,
  });
  useEffect(() => {
    if (frame) region.current?.focus({ preventScroll: true });
  }, [frame]);
  const catalog = useQuery({
    queryKey: ["private", apiUrl, member, refreshToken, "offline-catalog"],
    queryFn: ({ signal }) => getCampaigns(apiUrl, signal),
    enabled: online && Boolean(apiUrl),
  });
  async function refresh() {
    const [d, r] = await Promise.all([
      records<SavedDownload>("downloads", scope),
      records<LocalRun>("runs", scope),
    ]);
    setDownloads(d);
    setRuns(r);
    setLoading(false);
  }
  const report = (error: unknown) =>
    setProblem(
      error instanceof ApiError
        ? error.code
        : error instanceof Error
          ? error.message
          : "error",
    );
  useEffect(() => {
    let alive = true;
    void Promise.all([
      records<SavedDownload>("downloads", scope),
      records<LocalRun>("runs", scope),
    ])
      .then(([d, r]) => {
        if (alive) {
          setDownloads(d);
          setRuns(r);
          setLoading(false);
        }
      })
      .catch((error) => {
        if (alive) {
          report(error);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [scope]);
  useEffect(() => {
    let alive = true;
    setFrame(undefined);
    if (active)
      void recover(active)
        .then((value) => {
          if (alive) setFrame(value);
        })
        .catch((error) => {
          if (alive) report(error);
        });
    return () => {
      alive = false;
    };
  }, [active]);
  async function perform(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setProblem(undefined);
    try {
      await fn();
    } catch (error) {
      report(error);
    } finally {
      try {
        await refresh();
      } catch (error) {
        report(error);
      }
      setBusy(undefined);
    }
  }
  function exportRun(run: LocalRun) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(run, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `adventures-recovery-${run.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const checkpointSession = search.get("session") ?? undefined;
  const checkpointCampaign = search.get("campaign");
  return (
    <section
      className="feature-page offline-page"
      aria-labelledby="offline-title"
    >
      <h1 id="offline-title">
        {active ? active.download.bundle.portable.catalog.title : t("title")}
      </h1>
      {!active && <p>{t("intro")}</p>}
      <details className="offline-policy" open={!active}>
        <summary>{t("policy")}</summary>
        <p>{t("eligibility")}</p>
      </details>
      <Link className="app-button" to="/">
        {t("library")}
      </Link>
      {loading && <ResourceState state="loading" />}
      {runId && !loading && !active && <p role="alert">{t("notFound")}</p>}
      {problem && (
        <div role="alert">
          <p>{t(`errors.${problem}`, { defaultValue: t("error") })}</p>
          <button
            className="app-button"
            onClick={() => void perform("reload", refresh)}
          >
            {t("reload")}
          </button>
        </div>
      )}
      {deleting && (
        <div role="alertdialog" aria-label={t("delete")}>
          <p>
            {t(deleting.store === "runs" ? "confirmDelete" : "confirmRemove")}
          </p>
          <button
            className="app-button"
            onClick={() =>
              void perform("delete", async () => {
                await removeRecord(deleting.store, scope, deleting.key);
                setDeleting(undefined);
                if (deleting.store === "runs") navigate("/offline");
              })
            }
          >
            {t("confirm")}
          </button>
          <button className="app-button" onClick={() => setDeleting(undefined)}>
            {t("cancel")}
          </button>
        </div>
      )}
      {active && (
        <>
          <div className="offline-status" role="status">
            <p>{t(busy === "action" ? "saving" : "saved")}</p>
            <p>
              {t(
                busy === "sync"
                  ? "syncing"
                  : active.syncedCount === frame?.actions.length
                    ? "synced"
                    : "pending",
              )}
            </p>
          </div>
          {!frame && !problem && <ResourceState state="loading" />}
          {frame && (
            <div className="offline-player">
              <SceneRegion
                text={frame.scene.body.text}
                regionRef={region}
                theme={theme}
              />
              <ActionDeck
                actions={frame.scene.actions.map((action) => ({
                  id: action.id,
                  label: frame.strings[action.labelKey] ?? action.id,
                  available: action.available,
                  reason: action.reasonKey
                    ? frame.strings[action.reasonKey]
                    : undefined,
                }))}
                busy={Boolean(busy)}
                terminal={false}
                bbsSigil=""
                onChoose={(action) =>
                  void perform("action", async () => {
                    await advanceLocal(active, action);
                  })
                }
              />
              {frame.scene.status === "ended" && <p>{t("complete")}</p>}
              <p>{t("steps", { count: frame.actions.length })}</p>
            </div>
          )}
          {!member && <p>{t("guest")}</p>}
          <div className="offline-controls">
            <button
              className="app-button"
              disabled={!member || !online || Boolean(busy)}
              onClick={() =>
                void perform("sync", () => synchronize(apiUrl, member, active))
              }
            >
              {t(active.pending ? "retry" : "sync")}
            </button>
            <button className="app-button" onClick={() => exportRun(active)}>
              {t("export")}
            </button>
            <button
              className="app-button"
              disabled={Boolean(busy)}
              onClick={() => setDeleting({ store: "runs", key: active.key })}
            >
              {t("delete")}
            </button>
            <Link className="app-button" to="/offline">
              {t("localOnly")}
            </Link>
          </div>
        </>
      )}
      {!runId && (
        <>
          <h2>{t("downloads")}</h2>
          {!downloads.length && !loading && <p>{t("empty")}</p>}
          <div className="offline-grid">
            {downloads.map((download) => (
              <article key={download.key}>
                <h3>{download.bundle.portable.catalog.title}</h3>
                <p>{t("ready")}</p>
                <div className="offline-controls">
                  <button
                    className="app-button"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void perform("start", async () => {
                        const run = await startLocal(download);
                        navigate(`/offline/${run.id}`);
                      })
                    }
                  >
                    {t("start")}
                  </button>
                  <button
                    className="app-button"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      setDeleting({ store: "downloads", key: download.key })
                    }
                  >
                    {t("remove")}
                  </button>
                </div>
              </article>
            ))}
          </div>
          <h2>{t("runs")}</h2>
          <ul>
            {runs.map((run) => (
              <li key={run.id}>
                <Link to={`/offline/${run.id}`}>
                  {run.download.bundle.portable.catalog.title} — {t("resume")}
                </Link>
              </li>
            ))}
          </ul>
          {online && (
            <>
              <h2>{t("available")}</h2>
              {checkpointSession && <p>{t("checkpointNote")}</p>}
              {catalog.error && (
                <ResourceState
                  state="error"
                  error={catalog.error}
                  onRetry={() => void catalog.refetch()}
                />
              )}
              <div className="offline-grid">
                {catalog.data?.campaigns
                  .filter(
                    (c) => !c.hidden || c.campaignId === checkpointCampaign,
                  )
                  .map((c) => (
                    <article key={c.campaignId}>
                      <h3>{c.title}</h3>
                      {c.offline ? (
                        <button
                          className="app-button"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void perform(c.campaignId, () =>
                              downloadCampaign(
                                apiUrl,
                                scope,
                                c.campaignId,
                                setProgress,
                                c.campaignId === checkpointCampaign
                                  ? checkpointSession
                                  : undefined,
                              ),
                            )
                          }
                        >
                          {busy === c.campaignId
                            ? t("downloading", { progress })
                            : t(
                                c.campaignId === checkpointCampaign &&
                                  checkpointSession
                                  ? "checkpoint"
                                  : "download",
                              )}
                        </button>
                      ) : (
                        <p>{t("onlineOnly")}</p>
                      )}
                    </article>
                  ))}
              </div>
            </>
          )}
          {member && online && (
            <>
              <h2>{t("archive")}</h2>
              <button
                className="app-button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void perform("archive", async () => {
                    setArchive(
                      (
                        await request<{
                          runs: { localRunId: string; blob: string }[];
                        }>(apiUrl, "/api/offline/archive")
                      ).runs,
                    );
                  })
                }
              >
                {t("refreshArchive")}
              </button>
              <ul>
                {archive?.map((run) => (
                  <li key={run.localRunId}>
                    {JSON.parse(run.blob).campaignId} —{" "}
                    {t("steps", {
                      count: JSON.parse(run.blob).actionLog.length,
                    })}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
