import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.mjs";

const assets = new Map([
  ["/", ["<html>app shell</html>", "text/html"]],
  ["/assets/app-abcdefgh.js", ["export {}", "text/javascript"]],
  [
    "/manifest.webmanifest",
    ['{"name":"Adventures"}', "application/manifest+json"],
  ],
  ["/sw.js", ["// service worker", "text/javascript"]],
]);
function env() {
  const calls = [];
  return {
    calls,
    ASSETS: {
      async fetch(request) {
        const url = new URL(request.url);
        calls.push(url.pathname + url.search);
        const asset = assets.get(url.pathname);
        return asset
          ? new Response(asset[0], { headers: { "content-type": asset[1] } })
          : new Response("<html>404 document</html>", { status: 404 });
      },
    },
  };
}
const navigation = {
  accept: "text/html",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};
for (const path of [
  "/",
  "/profile",
  "/play/foo",
  "/discussions/123",
  "/u/someone",
  "/oauth/consent?authorization_id=abc",
  "/?campaign=foo",
  "/unknown-route",
]) {
  test(`navigation and refresh serve the shell at ${path}`, async () => {
    const binding = env();
    for (let i = 0; i < 2; i++) {
      const response = await worker.fetch(
        new Request(`https://site.example${path}`, { headers: navigation }),
        binding,
      );
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "<html>app shell</html>");
      assert.equal(response.headers.get("cache-control"), "no-cache");
    }
    assert.deepEqual(binding.calls, ["/", "/"]);
  });
}
for (const path of [
  "/assets/missing.js",
  "/assets/missing",
  "/campaigns/missing.json",
  "/icons/missing.png",
  "/missing.css",
  "/missing.woff2",
  "/missing.webmanifest",
  "/service-worker.js",
  "/workbox-missing.js",
  "/manifest",
  "/sw",
  "/api",
  "/api/campaigns",
  "/api/me",
  "/%61pi/campaigns",
  "/missing.js/",
]) {
  test(`missing resource never receives the shell: ${path}`, async () => {
    const response = await worker.fetch(
      new Request(`https://site.example${path}`, { headers: navigation }),
      env(),
    );
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Not found\n");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
}
test("fetches, scripts, POSTs and malformed URLs cannot receive navigation fallback", async () => {
  for (const options of [
    { headers: { accept: "application/json" } },
    { headers: { ...navigation, "sec-fetch-mode": "cors" } },
    { headers: { ...navigation, "sec-fetch-dest": "script" } },
    { method: "POST", headers: navigation },
  ]) {
    const response = await worker.fetch(
      new Request("https://site.example/profile", options),
      env(),
    );
    assert.equal(response.status, options.method === "POST" ? 405 : 404);
  }
  assert.equal(
    (
      await worker.fetch(
        new Request("https://site.example/%XX", { headers: navigation }),
        env(),
      )
    ).status,
    400,
  );
});
test("real assets retain MIME, hashed bundles cache immutably, and SW/manifest revalidate", async () => {
  for (const [path, [, mime]] of [...assets].slice(1)) {
    const response = await worker.fetch(
      new Request(`https://site.example${path}`, { headers: navigation }),
      env(),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), mime);
    assert.equal(
      response.headers.get("cache-control"),
      path.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );
  }
});
test("HEAD returns headers with no body; asset failures never become a successful shell", async () => {
  const response = await worker.fetch(
    new Request("https://site.example/profile", {
      method: "HEAD",
      headers: navigation,
    }),
    env(),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  const failed = await worker.fetch(
    new Request("https://site.example/profile", { headers: navigation }),
    {
      ASSETS: {
        fetch: async () => new Response("unavailable", { status: 503 }),
      },
    },
  );
  assert.equal(failed.status, 503);
});
