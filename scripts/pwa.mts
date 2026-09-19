import type { Plugin } from "vite";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Build-owned allowlist: never cache a response just because its URL looks static. */
export function pwaShell(): Plugin {
  let outDir: string;
  return {
    name: "adventures-pwa-shell",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async generateBundle() {
      const directory = new URL("../shared/offline/runtimes/", import.meta.url);
      for (const file of await readdir(directory)) {
        if (file.endsWith(".mjs"))
          this.emitFile({
            type: "asset",
            fileName: `/assets/offline-${file.replace(".mjs", ".js")}`.slice(1),
            source: await readFile(new URL(file, directory)),
          });
      }
    },
    async closeBundle() {
      const assets = (await readdir(resolve(outDir, "assets"))).map(
        (name) => `/assets/${name}`,
      );
      const paths = [
        "/index.html",
        "/manifest.webmanifest",
        "/favicon.svg",
        "/apple-touch-icon.png",
        "/icons/app-192.png",
        "/icons/app-512.png",
        "/icons/maskable-512.png",
        ...assets,
      ].sort();
      const digest = createHash("sha256");
      for (const path of paths)
        digest.update(await readFile(resolve(outDir, `.${path}`)));
      const template = await readFile(
        new URL("../src/pwa/worker.js", import.meta.url),
        "utf8",
      );
      const worker = template
        .replace("/* PRECACHE */ []", JSON.stringify(paths))
        .replace("BUILD_VERSION", digest.digest("hex").slice(0, 24));
      await writeFile(resolve(outDir, "sw.js"), worker);
    },
  };
}
