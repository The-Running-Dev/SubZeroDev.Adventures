import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

// npm's Windows launcher is a .cmd, which Node refuses to spawn directly. Run npm's
// own CLI under this Node rather than reaching for a shell.
const npmCli = process.env.npm_execpath;
const build = spawnSync(
  npmCli ? process.execPath : "npm",
  npmCli ? [npmCli, "run", "build"] : ["run", "build"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_ENABLE_PWA: "true",
      VITE_API_URL: "https://api.invalid",
    },
  },
);
assert.equal(
  build.status,
  0,
  `PWA test build must succeed: ${build.error?.message ?? build.status}`,
);
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
    if (file.includes("..")) throw new Error("invalid path");
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
const browser = await chromium.launch({
  executablePath: process.env.PWA_CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const context = await browser.newContext({ locale: "bg-BG" });
  const page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const urls = await page.evaluate(async () => {
    const keys = await caches.keys();
    return (
      await Promise.all(
        keys.map(async (key) =>
          (await (await caches.open(key)).keys()).map((r) => r.url),
        ),
      )
    ).flat();
  });
  assert(urls.some((url) => url.endsWith("/index.html")));
  assert(
    urls.every((url) => !url.includes("/api/") && !url.includes("/campaigns/")),
  );
  await context.setOffline(true);
  await page.close();
  const offline = await context.newPage();
  // Chromium 151 blocks new-target requests via context.setOffline but leaves
  // navigator.onLine true. Emulate the OS connectivity signal separately; keep
  // the context-wide network block in place throughout this cold launch.
  const network = await context.newCDPSession(offline);
  await network.send("Network.overrideNetworkState", {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await offline.goto(`${origin}/profile`);
  assert.equal(
    await offline.evaluate(async () => {
      try {
        await fetch("/__network-probe", { cache: "no-store" });
        return false;
      } catch {
        return true;
      }
    }),
    true,
    "Cold launch must have outbound networking blocked",
  );
  await network.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  try {
    await offline.getByText("Без интернет", { exact: true }).waitFor();
  } catch (error) {
    console.error(
      "Offline launch diagnostics",
      await offline.evaluate(() => ({
        online: navigator.onLine,
        language: navigator.language,
        languages: navigator.languages,
        lang: document.documentElement.lang,
        body: document.body.innerText,
        controller: navigator.serviceWorker.controller?.scriptURL,
      })),
    );
    throw error;
  }
  assert.equal(await offline.locator("html").getAttribute("lang"), "bg");
  assert.equal(
    await offline.locator('link[rel="manifest"]').getAttribute("href"),
    "/manifest.webmanifest",
  );
  await offline.goto(`${origin}/ranking`);
  await network.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await offline.getByText("Без интернет", { exact: true }).waitFor();
  await context.setOffline(false);
  await network.send("Network.overrideNetworkState", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  version = "B";
  await offline.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    await r.update();
  });
  await offline.getByText("Има нова версия", { exact: true }).waitFor();
  const other = await context.newPage();
  await other.goto(origin);
  await offline
    .getByRole("button", { name: "Обнови сега", exact: true })
    .click();
  await offline
    .getByRole("button", { name: "Презареди и обнови", exact: true })
    .click();
  await offline
    .getByRole("alert")
    .filter({ hasText: "Затвори другите раздели" })
    .waitFor();
  await other.close();
  await offline
    .getByRole("button", { name: "Презареди и обнови", exact: true })
    .click();
  await offline.waitForEvent("load");
  assert.equal(await offline.locator("html").getAttribute("lang"), "bg");
  await context.close();
  console.log(
    "PWA verified: complete static precache, no API/catalog cache, offline cold navigation in Bulgarian, prompted update and multi-tab protection.",
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
