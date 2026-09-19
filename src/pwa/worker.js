/* Generated with a complete immutable asset allowlist by scripts/pwa.mts. */
const PRECACHE = /* PRECACHE */ [];
const CACHE = "adventures-shell-BUILD_VERSION";
const STATIC = new Set(PRECACHE);
const ROUTES =
  /^\/(?:|offline(?:\/[^/.]+)?\/?|ranking\/?|profile\/?|content\/?|start\/?|discussions(?:\/[^/.]+)?\/?|u\/[^/.]+\/?|play\/[^/.]+\/?|oauth\/consent\/?)$/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // A partial download fails installation. No API calls, cookies or opaque responses.
      await cache.addAll(
        PRECACHE.map(
          (path) => new Request(path, { credentials: "omit", cache: "reload" }),
        ),
      );
    })(),
  );
});

// Keep older shell caches: another tab (and later a pinned offline runtime) may still
// need them. Lifecycle cleanup must know which runtimes durable runs reference.
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "ACTIVATE_UPDATE") return;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Activating affects every tab. Never interrupt a different tab's live game/form.
      if (clients.length > 1) {
        event.source?.postMessage({ type: "UPDATE_BLOCKED" });
        return;
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // Exact allowlist, with navigation restricted to application routes. APIs, viewer
  // catalog, auth callbacks, fixture campaigns and missing resources stay network-only.
  const navigation = request.mode === "navigate" && ROUTES.test(url.pathname);
  if (!navigation && (!STATIC.has(url.pathname) || url.search)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(
        navigation ? "/index.html" : url.pathname,
      );
      return cached ?? fetch(request);
    })(),
  );
});
