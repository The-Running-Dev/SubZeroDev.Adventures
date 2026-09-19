import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const origin = new URL(process.env.HOSTING_URL ?? "http://127.0.0.1:8080");
if (
  origin.protocol !== "https:" &&
  !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
)
  throw new Error("Public hosting checks require HTTPS");
const navigation = {
  accept: "text/html",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};
function get(path, headers = navigation, method = "GET") {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    // Raw HTTP preserves browser navigation headers; Node fetch supplies cors mode.
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      { headers, method, timeout: 10000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`Timed out: ${path}`)));
    req.end();
  });
}

for (const path of [
  "/",
  "/profile",
  "/ranking",
  "/content",
  "/start",
  "/play/foo",
  "/discussions/123",
  "/u/someone",
  "/oauth/consent?authorization_id=probe",
  "/?campaign=foo",
  "/unknown-route",
]) {
  test(`direct navigation and refresh: ${path}`, async () => {
    const first = await get(path);
    const refresh = await get(path);
    for (const response of [first, refresh]) {
      assert.equal(response.status, 200, path);
      assert.match(response.headers["content-type"], /text\/html/);
      assert.equal(response.headers["cache-control"], "no-cache");
      assert.match(response.body, /id="root"/);
      assert.equal(response.headers.location, undefined);
    }
    assert.equal(refresh.body, first.body);
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
  "/service-worker-missing.js",
  "/workbox-missing.js",
  "/manifest",
  "/sw",
  "/api",
  "/api/campaigns",
  "/api/me",
  "/%61pi/campaigns",
  "/missing.js/",
  "/404.html",
]) {
  test(`missing resource is a real error: ${path}`, async () => {
    const response = await get(path);
    assert.equal(response.status, 404);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.doesNotMatch(
      response.body,
      /id="root"|spa_redirect|<!doctype html>/i,
    );
  });
}
test("ordinary fetch, script request and POST cannot use SPA fallback", async () => {
  for (const headers of [
    { accept: "application/json" },
    { ...navigation, "sec-fetch-mode": "cors" },
    { ...navigation, "sec-fetch-dest": "script" },
  ])
    assert.equal((await get("/profile", headers)).status, 404);
  assert.equal((await get("/profile", navigation, "POST")).status, 405);
});
test("real JS/CSS assets preserve MIME and cache immutable filenames", async () => {
  const shell = await get("/");
  const bundles = [
    ...shell.body.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g),
  ].map((match) => match[1]);
  assert.ok(bundles.length >= 2, "Expected built JS and CSS");
  for (const path of bundles) {
    const response = await get(path, { accept: "*/*" });
    assert.equal(response.status, 200);
    assert.match(
      response.headers["content-type"],
      path.endsWith(".css") ? /text\/css/ : /javascript/,
    );
    assert.match(response.headers["cache-control"], /immutable/);
    assert.doesNotMatch(response.body, /<!doctype html>/i);
  }
});
for (const path of ["/sw.js", "/service-worker.js", "/manifest.webmanifest"]) {
  test(`SW/manifest is a real file or an error: ${path}`, async () => {
    const response = await get(path);
    assert.ok([200, 404].includes(response.status));
    assert.doesNotMatch(response.body, /id="root"|<!doctype html>/i);
    if (response.status === 200) {
      assert.match(
        response.headers["content-type"],
        path.endsWith(".js") ? /javascript/ : /json/,
      );
      assert.equal(response.headers["cache-control"], "no-cache");
    }
  });
}
test("HEAD preserves successful navigation status without a body", async () => {
  const response = await get("/profile", navigation, "HEAD");
  assert.equal(response.status, 200);
  assert.equal(response.body, "");
});
test("health/revision endpoint identifies the exact build without caching", async () => {
  const response = await get("/__build-id", { accept: "text/plain" });
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.body.trim(), /^(development|[0-9a-f]{40})$/);
  if (process.env.EXPECTED_BUILD_REVISION)
    assert.equal(response.body.trim(), process.env.EXPECTED_BUILD_REVISION);
});
