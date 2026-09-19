function missing(request, status = 404) {
  return new Response(request.method === "HEAD" ? null : "Not found\n", {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD")
      return missing(request, 405);
    const url = new URL(request.url);
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return missing(request, 400);
    }
    // The API stays on its existing origin. Never rewrite or proxy private data.
    if (/^\/api(?:\/|$)/i.test(path)) return missing(request);
    const mode = request.headers.get("sec-fetch-mode");
    const destination = request.headers.get("sec-fetch-dest");
    const navigation =
      (mode === "navigate" || mode === null) &&
      (destination === "document" || destination === null) &&
      (request.headers.get("accept") ?? "").includes("text/html");
    const resource =
      /^\/(?:assets|campaigns|icons|fonts|images)(?:\/|$)/i.test(path) ||
      /\.[^/]+\/?$/.test(path) ||
      /^\/(?:sw|service-worker|manifest|_worker)(?:\/|$)/i.test(path);
    const shell = navigation && !resource;
    if (shell) {
      // Fetch the root asset directly; Pages redirects /index.html to /.
      url.pathname = "/";
      url.search = "";
    }
    const response = await env.ASSETS.fetch(new Request(url, request));
    if (response.status === 404) return missing(request);
    const headers = new Headers(response.headers);
    headers.set("x-content-type-options", "nosniff");
    if (response.status >= 400) {
      headers.set("cache-control", "no-store");
    } else if (shell || headers.get("content-type")?.includes("text/html")) {
      headers.set("cache-control", "no-cache");
      headers.set("vary", "Accept, Sec-Fetch-Mode, Sec-Fetch-Dest");
    } else if (/^\/assets\/[^/]+-[\w-]{8,}\.[^/]+$/.test(path)) {
      headers.set("cache-control", "public, max-age=31536000, immutable");
    } else {
      // Includes future manifest and service-worker files: revalidate updates.
      headers.set("cache-control", "no-cache");
    }
    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
