import { useEffect, useRef, useState, useSyncExternalStore } from "react";

type InstallPrompt = Event & {
  prompt: () => Promise<{ outcome: "accepted" | "dismissed" }>;
};
const subscribeConnectivity = (notify: () => void) => {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
};
export function useOnline() {
  return useSyncExternalStore(
    subscribeConnectivity,
    () => navigator.onLine,
    () => true,
  );
}

export function usePwa(
  enabled = import.meta.env.PROD && import.meta.env.VITE_ENABLE_PWA === "true",
) {
  const online = useOnline();
  const [install, setInstall] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(
    () =>
      window.matchMedia?.("(display-mode: standalone)").matches ||
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
  );
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [problem, setProblem] = useState<
    "tabs" | "registration" | "install" | null
  >(null);
  const [applying, setApplying] = useState(false);
  const approved = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstall(event as InstallPrompt);
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstall(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    let alive = true;
    let cleanup = () => {};
    if ("serviceWorker" in navigator) {
      const onController = () => {
        // First install or an update approved by another tab must not reload us.
        if (approved.current) window.location.reload();
      };
      const onMessage = (event: MessageEvent) => {
        if (event.data?.type === "UPDATE_BLOCKED") {
          approved.current = false;
          setApplying(false);
          setProblem("tabs");
        }
      };
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        onController,
      );
      navigator.serviceWorker.addEventListener("message", onMessage);
      void navigator.serviceWorker
        .register("/sw.js", { updateViaCache: "none" })
        .then((registration) => {
          if (!alive) return;
          const observe = () => {
            if (registration.waiting && navigator.serviceWorker.controller)
              setWaiting(registration.waiting);
          };
          const workers = new Set<ServiceWorker>();
          const onUpdate = () => {
            const worker = registration.installing;
            if (worker) {
              workers.add(worker);
              worker.addEventListener("statechange", observe);
            }
            observe();
          };
          onUpdate();
          registration.addEventListener("updatefound", onUpdate);
          const check = () => {
            if (document.visibilityState === "visible")
              void registration.update().catch(() => {});
          };
          document.addEventListener("visibilitychange", check);
          cleanup = () => {
            registration.removeEventListener("updatefound", onUpdate);
            document.removeEventListener("visibilitychange", check);
            for (const worker of workers)
              worker.removeEventListener("statechange", observe);
          };
        })
        .catch(() => {
          if (alive) setProblem("registration");
        });
      return () => {
        alive = false;
        cleanup();
        window.removeEventListener("beforeinstallprompt", onPrompt);
        window.removeEventListener("appinstalled", onInstalled);
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          onController,
        );
        navigator.serviceWorker.removeEventListener("message", onMessage);
      };
    }
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [enabled]);
  return {
    online,
    installed,
    waiting,
    applying,
    problem,
    canInstall: Boolean(install) && !installed,
    ios:
      enabled &&
      !installed &&
      (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)),
    async install() {
      if (!install) return;
      setInstall(null);
      try {
        await install.prompt();
      } catch {
        setProblem("install");
      }
    },
    update() {
      if (!waiting || applying) return;
      approved.current = true;
      setApplying(true);
      setProblem(null);
      waiting.postMessage({ type: "ACTIVATE_UPDATE" });
    },
  };
}
