import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";
import { platform } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

// Only `chromium-linux` baselines are committed (CLAUDE.md) -- CI runs on ubuntu-latest and
// that is the only set it ever compares against. Excluded here, at config load (which always
// runs in Node), rather than inside the spec itself: the spec file is also loaded into the
// real browser tab it tests in, where a Node platform check has no equivalent.
const visualBaselineSpec = "src/play/browser/visual-baseline.browser.test.tsx";

// Real-browser counterpart to vite.config.ts's jsdom project (ported from the engine
// repo's W65). jsdom performs no layout, so it cannot back a computed-style, hit-area, or
// horizontal-overflow assertion -- these specs run inside an actual Chromium tab instead.
// Kept as a separate config, not a `test.projects` entry: `npm test` stays fast and
// unchanged, `npm run test:browser` is the real-browser gate `npm run check` also runs.
//
// CI here runs on ubuntu-latest with Playwright's managed Chromium (`playwright install
// --with-deps chromium`) -- unlike the engine repo's docs-CI, which runs inside an Alpine
// container and needs a system-Chromium override. That override does not apply here.
export default defineConfig({
  plugins: [react()],
  server: { fs: { allow: [projectRoot, resolve(projectRoot, "engine")] } },
  // Pre-bundling the engine package (and its @noble/hashes dependency) mid-run triggers a
  // Vite dependency-optimizer reload that can flake a test run -- listing it here forces
  // the pre-bundle before any test starts.
  optimizeDeps: {
    include: ["@the-running-dev/game-engine"],
  },
  test: {
    include: ["src/**/*.browser.test.{ts,tsx}"],
    exclude:
      platform() === "win32"
        ? [...configDefaults.exclude, visualBaselineSpec]
        : configDefaults.exclude,
    setupFiles: ["./src/test/browser-setup.ts"],
    // The unavailable-choice fixture (fixtures.tsx) retries a real, randomly-forking route
    // up to 60 times in the worst case.
    testTimeout: 30000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
      viewport: { width: 1280, height: 800 },
    },
  },
});
