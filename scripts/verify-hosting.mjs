import assert from "node:assert/strict";

const origin = new URL(process.argv[2] ?? process.env.HOSTING_URL);
assert.equal(origin.protocol, "https:", "Hosting checks require HTTPS");
assert.equal(origin.pathname, "/", "Supply the deployment origin, not a route");
const navigation = {
  accept: "text/html",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};
async function get(path, headers = navigation) {
  const response = await fetch(new URL(path, origin), {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  return { response, body: await response.text() };
}
let shell;
for (const path of [
  "/",
  "/profile",
  "/play/hosting-probe",
  "/discussions/1",
  "/u/hosting-probe",
  "/oauth/consent?authorization_id=hosting-probe",
  "/?campaign=hosting-probe",
]) {
  for (let refresh = 0; refresh < 2; refresh++) {
    const { response, body } = await get(path);
    assert.equal(response.status, 200, path);
    assert.match(
      response.headers.get("content-type") ?? "",
      /text\/html/,
      path,
    );
    assert.match(body, /id="root"/, path);
    assert.equal(response.headers.get("cache-control"), "no-cache", path);
    shell ??= body;
    assert.equal(body, shell, `Different shell at ${path}`);
  }
}
const bundles = [
  ...shell.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g),
].map((match) => match[1]);
assert.ok(bundles.length >= 2, "No bundled JS/CSS references");
for (const path of bundles) {
  const { response, body } = await get(path, { accept: "*/*" });
  assert.equal(response.status, 200, path);
  assert.match(
    response.headers.get("content-type") ?? "",
    path.endsWith(".css") ? /text\/css/ : /javascript/,
    path,
  );
  assert.match(response.headers.get("cache-control") ?? "", /immutable/, path);
  assert.doesNotMatch(body, /<!doctype html>/i, path);
}
for (const path of [
  "/assets/hosting-missing.js",
  "/assets/hosting-missing",
  "/hosting-missing.css",
  "/icons/hosting-missing.png",
  "/hosting-missing.webmanifest",
  "/hosting-missing-worker.js",
  "/api/me",
  "/api/campaigns",
]) {
  const { response, body } = await get(path);
  assert.equal(response.status, 404, path);
  assert.equal(response.headers.get("cache-control"), "no-store", path);
  assert.doesNotMatch(body, /id="root"|spa_redirect|<!doctype html>/i, path);
}
for (const path of ["/sw.js", "/service-worker.js", "/manifest.webmanifest"]) {
  const { response, body } = await get(path);
  assert.ok(response.status === 404 || response.status === 200, path);
  assert.doesNotMatch(body, /id="root"|<!doctype html>/i, path);
  if (response.status === 200) {
    assert.match(
      response.headers.get("content-type") ?? "",
      path.endsWith(".js") ? /javascript/ : /json/,
      path,
    );
    assert.equal(response.headers.get("cache-control"), "no-cache", path);
  }
}
const ordinaryFetch = await get("/profile", {
  accept: "application/json",
  "sec-fetch-mode": "cors",
});
assert.equal(ordinaryFetch.response.status, 404);
console.log(
  `PASS: HTTPS, repeated direct routes, ${bundles.length} bundles, missing resources, MIME types and cache headers at ${origin.origin}`,
);
console.log(
  "Browser identity/cookies/CORS/OAuth and DNS rollback still require the migration runbook checks.",
);
