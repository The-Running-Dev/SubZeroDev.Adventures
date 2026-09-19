/** Production browser + real API/Postgres. No mocked gameplay or synchronization. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { chromium } from "playwright";
import axe from "axe-core";

assert(process.env.DATABASE_URL, "Use a dedicated migrated test database");
process.env.NODE_ENV = "test";
process.env.CAMPAIGNS_DIR = resolve("public/campaigns");
const requireServer = createRequire(resolve("server/package.json"));
const { Pool } = requireServer("pg");
const { buildApp } = await import("../server/dist/server/src/app.js");
const { validateBundle } =
  await import("../server/dist/shared/offline/runtime.js");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let version = "A";
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    const file = path === "/" || !extname(path) ? "/index.html" : path;
    if (file.includes("..")) throw Error("invalid path");
    let content = await readFile(resolve("dist", `.${file}`));
    if (file === "/sw.js")
      content = Buffer.from(
        content
          .toString()
          .replaceAll("adventures-shell-", `adventures-shell-${version}-`),
      );
    res.writeHead(200, {
      "Content-Type": mime[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const app = await buildApp(pool, { siteUrl: origin, apiUrl: origin });
const api = await app.listen({ port: 0, host: "127.0.0.1" });
const profile = await mkdtemp(resolve(tmpdir(), "adventures-offline-"));
let context, page;
const owners = [];
async function member() {
  const id = randomUUID(),
    token = randomUUID();
  owners.push(id);
  await pool.query("insert into players(player_id,kind) values($1,'member')", [
    id,
  ]);
  await pool.query(
    "insert into auth_sessions(token_hash,player_id,expires_at) values($1,$2,now()+interval '1 day')",
    [createHash("sha256").update(token).digest("hex"), id],
  );
  return { id, token };
}
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.PWA_CHROMIUM_PATH || undefined,
    headless: true,
    locale: "en-US",
    viewport: { width: 390, height: 844 },
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(15000);
}
async function signIn(identity) {
  await context.addCookies([
    {
      name: "sza_session",
      value: identity.token,
      url: api,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}
async function connectivity(offline) {
  await context.setOffline(offline);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.emulateNetworkConditions", {
    offline,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
}
async function runRecord() {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("subzerodev-offline-v1");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const r = db.transaction("runs").objectStore("runs").getAll();
        r.onsuccess = () => resolve(r.result[0]);
        r.onerror = () => reject(r.error);
      });
    } finally {
      db.close();
    }
  });
}
async function action() {
  const before = await runRecord();
  await page
    .locator(".offline-player .action-deck button:enabled")
    .first()
    .click();
  await page.waitForFunction(async (revision) => {
    const db = await new Promise((resolve) => {
      const r = indexedDB.open("subzerodev-offline-v1");
      r.onsuccess = () => resolve(r.result);
    });
    try {
      return await new Promise((resolve) => {
        const r = db.transaction("runs").objectStore("runs").getAll();
        r.onsuccess = () => resolve(r.result[0]?.revision > revision);
      });
    } finally {
      db.close();
    }
  }, before.revision);
  await page.getByText("Saved on this device", { exact: true }).waitFor();
}
try {
  const build = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build"],
    {
      stdio: "inherit",
      env: { ...process.env, VITE_ENABLE_PWA: "true", VITE_API_URL: api },
    },
  );
  assert.equal(build.status, 0);
  const owner = await member();
  const statsBefore = (
    await app.inject({ method: "GET", url: "/api/stats" })
  ).json();
  await launch();
  await signIn(owner);
  await page.goto(`${origin}/offline?campaign=getting-started`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const title = JSON.parse(
    await readFile("public/campaigns/getting-started.json", "utf8"),
  ).catalog.title;
  await page
    .locator(".offline-grid article")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .getByRole("button", { name: "Download", exact: true })
    .click();
  await page.getByText("Ready on this device", { exact: true }).waitFor();
  await connectivity(true);
  assert(
    await page.evaluate(async () => {
      try {
        await fetch("/__network-probe");
        return false;
      } catch {
        return true;
      }
    }),
    "Outbound network must be blocked",
  );
  await page
    .getByRole("button", { name: "Start offline run", exact: true })
    .click();
  await page.locator(".offline-player .scene-region").waitFor();
  await action();
  const saved = await runRecord();
  const runUrl = page.url();
  console.log(
    "Offline start and atomic action verified; closing the whole browser.",
  );
  await context.close();
  await launch();
  await connectivity(true);
  await page.goto(runUrl);
  // Chromium navigation can reset its connectivity signal independently of its network block.
  await connectivity(true);
  await page.locator(".offline-player .scene-region").waitFor();
  assert.equal((await runRecord()).blob, saved.blob);
  assert(
    await page.evaluate(async () => {
      try {
        await fetch("/__network-probe");
        return false;
      } catch {
        return true;
      }
    }),
  );
  let count = 0;
  while (
    !(await page.getByText("Adventure complete", { exact: true }).isVisible())
  ) {
    assert(++count < 100, "Existing campaign must reach an ending");
    await action();
  }
  const completed = await runRecord();
  assert.equal(JSON.parse(completed.blob).gameId, saved.inputs.gameId);
  console.log("Full offline campaign completed after browser restart.");
  await connectivity(false);
  await page
    .getByRole("button", { name: "Synchronize", exact: true })
    .waitFor();
  // An application update remains prompted and retains the older build's exact runtime bytes.
  version = "B";
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration()).update();
  });
  await page.getByRole("button", { name: "Update now", exact: true }).waitFor();
  assert.equal((await runRecord()).blob, completed.blob);
  await page.getByRole("button", { name: "Update now", exact: true }).click();
  await page
    .getByRole("button", { name: "Reload and update", exact: true })
    .click();
  await page.waitForEvent("load");
  await page.locator(".offline-player .scene-region").waitFor();
  assert.equal(
    (await runRecord()).download.runtimeCode,
    saved.download.runtimeCode,
  );
  assert.equal((await runRecord()).blob, completed.blob);
  let intercepted;
  await page.route(
    `${api}/api/offline/sync`,
    async (route) => {
      intercepted = route.request().postDataJSON();
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort("failed");
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "Synchronize", exact: true }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  assert.deepEqual((await runRecord()).pending, intercepted);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("Validated by server", { exact: true }).waitFor();
  const synced = await runRecord();
  const authoritative = validateBundle(synced.download.bundle).replay(
    synced.download.bundle.portable,
    synced.inputs,
    JSON.parse(synced.blob).actionLog,
  );
  const rows = (
    await pool.query(
      "select blob from offline_runs where owner_id=$1 and local_run_id=$2",
      [owner.id, synced.id],
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].blob, authoritative.blob);
  assert.equal(synced.blob, authoritative.blob);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from offline_receipts where owner_id=$1",
        [owner.id],
      )
    ).rows[0].n,
    1,
  );
  assert.deepEqual(
    (await app.inject({ method: "GET", url: "/api/stats" })).json(),
    statsBefore,
  );
  console.log(
    "Lost response, exact retry, single receipt and authoritative deterministic state verified.",
  );
  // Cross-account visibility is exercised through verified identities, never by editing local run ownership.
  const other = await member();
  await signIn(other);
  await page.reload();
  await page
    .getByText(
      "This run is not available for the current account on this device.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.locator(".offline-player").count(), 0);
  await signIn(owner);
  await page.reload();
  await page.locator(".offline-player").waitFor();
  await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { cookie: `sza_session=${owner.token}` },
  });
  await page.reload();
  await page
    .getByText(
      "This run is not available for the current account on this device.",
      { exact: true },
    )
    .waitFor();
  await connectivity(true);
  await page.reload();
  await connectivity(true);
  await page
    .getByText(
      "This run is not available for the current account on this device.",
      { exact: true },
    )
    .waitFor();
  // Localized small-screen layout and accessibility of offline management.
  await connectivity(false);
  await signIn(other);
  await page.goto(`${origin}/offline`);
  await page.evaluate(() => {
    localStorage.setItem("subzerodev.play.locale.v1", "bg");
  });
  await page.reload();
  await page
    .getByRole("heading", { name: "Приключения без интернет", exact: true })
    .waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "bg");
  await page.setViewportSize({ width: 320, height: 740 });
  await page.addScriptTag({ content: axe.source });
  const audit = await page.evaluate(async () =>
    window.axe.run(document.querySelector(".offline-page"), {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    }),
  );
  assert.deepEqual(
    audit.violations.map((x) => ({
      id: x.id,
      nodes: x.nodes.map((n) => n.target),
    })),
    [],
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  console.log(
    "Offline E2E passed: real download/API replay, blocked-network start/play/restart/completion, retained runtime through update, lost-response retry, unchanged aggregates, account switch/logout and mobile accessibility.",
  );
} catch (error) {
  console.error(
    "Offline E2E diagnostics:",
    await page
      ?.locator("body")
      .innerText()
      .catch(() => "unavailable"),
  );
  throw error;
} finally {
  await context?.close();
  for (const id of owners)
    await pool.query("delete from players where player_id=$1", [id]);
  await app.close();
  await pool.end();
  await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true });
}
