import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

const origin = new URL(process.argv[2] ?? process.env.HOSTING_URL);
if (origin.protocol !== "https:" || origin.pathname !== "/")
  throw new Error("Supply the HTTPS deployment origin, not a route");
// Portainer acknowledges its webhook before the new container is serving, and the
// redeploy pulls two fresh images first. Five minutes, not one -- a slow pull must not
// fail a deployment that then succeeds twenty seconds later.
if (process.env.EXPECTED_BUILD_REVISION) {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch(new URL("/__build-id", origin), {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (
        response.ok &&
        (await response.text()).trim() === process.env.EXPECTED_BUILD_REVISION
      ) {
        ready = true;
        break;
      }
    } catch {
      /* The reverse proxy may briefly have no healthy upstream. */
    }
    await setTimeout(2000);
  }
  if (!ready)
    throw new Error("Portainer did not serve the expected frontend revision");
}
execFileSync(process.execPath, ["--test", "frontend/hosting.test.mjs"], {
  stdio: "inherit",
  env: { ...process.env, HOSTING_URL: origin.origin },
});
console.log(
  "Browser cookies/CORS/OAuth and proxy/DNS cutover still require docs/frontend-hosting.md checks.",
);
