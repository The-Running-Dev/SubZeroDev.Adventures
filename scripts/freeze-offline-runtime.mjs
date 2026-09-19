// An explicit author-time operation, never run by an app build. Retain old artifacts.
import { build } from "rolldown";
import { execFileSync } from "node:child_process";
import { access, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const commit = execFileSync("git", ["-C", "engine", "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const file = `shared/offline/runtimes/${commit}.mjs`;
try {
  await access(file);
  throw Error("Runtime already frozen; never overwrite a published runtime.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await build({
  input: "shared/offline/runtime-source.ts",
  platform: "browser",
  output: { file, format: "esm", minify: true },
});
const sha256 = createHash("sha256")
  .update(await readFile(file))
  .digest("hex");
await writeFile(
  `shared/offline/runtimes/${commit}.d.mts`,
  'export * from "../runtime-source.js";\n',
);
await writeFile(
  "shared/offline/runtime-id.ts",
  `// Frozen bytes from engine commit ${commit}.\nexport const RUNTIME_ID = ${JSON.stringify(commit)};\nexport const RUNTIME_SHA256 = ${JSON.stringify(sha256)};\n`,
);
console.log({ commit, sha256 });
