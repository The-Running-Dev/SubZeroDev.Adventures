import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

// Polls the `__build-id` file `scripts/deploy-preview.mjs` writes beside the bundle and
// reloads when it changes -- the "and tells the browser to reload" half of the preview
// loop (docs/preview.md), without the preview host needing to be anything but a static
// file server. The first response only records the id; a reload happens on a *change*, so
// opening the page mid-deploy can't reload it into the build it already has.
const reloadSnippet = (buildIdUrl: string) => `(() => {
  let current = null;
  const check = async () => {
    try {
      const response = await fetch(${JSON.stringify(buildIdUrl)}, { cache: "no-store" });
      if (!response.ok) return;
      const id = (await response.text()).trim();
      if (current === null) current = id;
      else if (id !== current) location.reload();
    } catch {
      // A deploy swaps the whole directory underneath us, so a failed poll is the
      // expected mid-deploy state, not an error worth surfacing. Next tick retries.
    }
  };
  void check();
  setInterval(() => void check(), 3000);
})();`;

// Build-only, and only when `PREVIEW_RELOAD=1` -- `deploy.yml` sets no such variable, so
// the production bundle never carries this and never polls.
function previewReload(): Plugin {
  // Resolved from the config rather than hardcoded to "/": the poll has to be an absolute
  // URL, because this app dispatches on `location.pathname` (main.tsx) and a relative one
  // would resolve against /u/<slug> or /oauth/consent and 404.
  let buildIdUrl = "/__build-id";
  return {
    name: "preview-reload",
    apply: "build",
    configResolved(config) {
      buildIdUrl = config.base.endsWith("/")
        ? `${config.base}__build-id`
        : `${config.base}/__build-id`;
    },
    transformIndexHtml() {
      if (process.env.PREVIEW_RELOAD !== "1") return;
      return [
        {
          tag: "script",
          injectTo: "body",
          children: reloadSnippet(buildIdUrl),
        },
      ] as const;
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), previewReload()],
  server: { fs: { allow: [projectRoot, resolve(projectRoot, "engine")] } },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    // Vite's env loading picks up a developer's .env.local regardless of mode, so a local
    // VITE_API_URL leaks into import.meta.env here and silently switches createBrowserDemo()
    // (src/play/composition.ts) into remote mode, sending unstubbed fetches. Force local mode
    // for the suite itself rather than relying on the environment not to have that file.
    env: { VITE_API_URL: "" },
    // Constrained to this repo's own src/ and shared/ rather than excluding engine/ by
    // name -- the submodule carries its own test suite (and its own vitest config), which
    // is not this repo's to run. shared/ is environment-neutral code both compositions
    // import (CLAUDE.md's Structure table); it has no browser-only surface to test under
    // vitest.browser.config.ts, so it runs here instead of being orphaned. Real-browser
    // specs (ported from the engine repo's W65) live alongside src/ under
    // src/**/*.browser.test.* and run only via vitest.browser.config.ts's
    // `npm run test:browser` -- jsdom performs no layout, so they'd fail here for the wrong
    // reason.
    include: ["src/**/*.test.{ts,tsx}", "shared/**/*.test.{ts,tsx}"],
    exclude: ["**/*.browser.test.{ts,tsx}"],
  },
});
