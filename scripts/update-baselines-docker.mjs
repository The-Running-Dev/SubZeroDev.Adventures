/**
 * Regenerates the `chromium-linux` visual baselines from a Windows (or any) checkout, by
 * running the browser suite inside the same kind of container CI does. `npm run
 * baselines:update`.
 *
 * This exists because of the asymmetry CLAUDE.md documents: `vitest.browser.config.ts`
 * skips the visual specs entirely on win32, so a UI change made here gets no local
 * visual-regression signal at all and CI is the first thing to notice. Regenerating used
 * to mean hand-typing a long `docker run` (and getting the image right), which is exactly
 * the kind of friction that turns one push into three.
 *
 * Two things it is careful about that the hand-typed command was not:
 *
 *  - `node:24`, never `mcr.microsoft.com/playwright`. That image's bundled Chromium renders
 *    text a few pixels taller at every non-320px width than the one `playwright install
 *    --with-deps` downloads on ubuntu-latest, so baselines generated under it pass locally
 *    and fail in CI. This is not a preference; it broke this repo's first CI run.
 *  - Anonymous volumes over both `node_modules` trees. The repository is bind-mounted, so a
 *    bare `npm ci` in the container would replace the host's Windows-native binaries
 *    (esbuild, rollup) with Linux ones and leave the host checkout unable to run anything
 *    until it was reinstalled. The anonymous volumes give the container its own empty
 *    node_modules to fill and leave the host's untouched.
 *
 * Named volumes cache the npm and Playwright downloads between runs -- without them every
 * regeneration re-downloads a Chromium.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// Docker wants a POSIX-ish path even on Windows; a drive-letter path works, but backslashes
// do not.
const mountSource = repoRoot.replace(/\\/g, "/").replace(/\/$/, "");

const args = [
  "run",
  "--rm",
  "-v",
  `${mountSource}:/w`,
  "-v",
  "/w/node_modules",
  "-v",
  "/w/engine/src/engine/node_modules",
  "-v",
  "subzerodev-adventures-npm:/root/.npm",
  "-v",
  "subzerodev-adventures-playwright:/root/.ms-playwright",
  "-e",
  "PLAYWRIGHT_BROWSERS_PATH=/root/.ms-playwright",
  "-w",
  "/w",
  "node:24",
  "bash",
  "-lc",
  // `npm ci` runs the `prepare` script, which builds the engine submodule -- no separate
  // `npm run setup` needed, same as CI.
  "npm ci && npx playwright install --with-deps chromium && npm run test:browser:update",
];

console.log("docker " + args.join(" "));
const result = spawnSync("docker", args, { stdio: "inherit" });
if (result.error) {
  throw new Error(
    `Could not run docker: ${result.error.message}. Docker Desktop must be running.`,
  );
}
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(
  "\nBaselines regenerated. Review the PNG diff and commit it with the change that caused it.",
);
