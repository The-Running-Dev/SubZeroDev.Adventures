import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const output = new URL("../dist-cloudflare/", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL("../dist/", import.meta.url), output, { recursive: true });
await cp(
  new URL("../hosting/cloudflare/worker.mjs", import.meta.url),
  new URL("_worker.js", output),
);
// Disable Pages' implicit catch-all. The Worker alone decides which requests
// receive the shell. This is NOT the GitHub Pages redirect document.
await writeFile(
  new URL("404.html", output),
  '<!doctype html><html lang="en"><title>Not found</title><h1>Not found</h1></html>\n',
);
await writeFile(
  new URL("_routes.json", output),
  JSON.stringify({ version: 1, include: ["/*"], exclude: [] }),
);
const html = await readFile(new URL("index.html", output), "utf8");
if (!html.includes('id="root"')) throw new Error("Missing application shell");
console.log("Cloudflare artifact prepared; GitHub Pages output preserved.");
