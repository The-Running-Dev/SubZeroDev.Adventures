import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { fs: { allow: [projectRoot, resolve(projectRoot, "engine")] } },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    // Vite's env loading picks up a developer's .env.local regardless of mode, so a local
    // VITE_API_URL leaks into import.meta.env here and silently switches createBrowserDemo()
    // (src/play/composition.ts) into remote mode, sending unstubbed fetches. Force local mode
    // for the suite itself rather than relying on the environment not to have that file.
    env: { VITE_API_URL: "" },
    // Constrained to this repo's own src/ rather than excluding engine/ by name -- the
    // submodule carries its own test suite (and its own vitest config), which is not this
    // repo's to run. Real-browser specs (ported from the engine repo's W65) live alongside
    // these under src/**/*.browser.test.* and run only via vitest.browser.config.ts's
    // `npm run test:browser` -- jsdom performs no layout, so they'd fail here for the wrong
    // reason.
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/*.browser.test.{ts,tsx}"],
  },
});
