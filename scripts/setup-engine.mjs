/**
 * Bootstraps the engine submodule so the `file:./engine/src/engine` dependency has
 * something to resolve to.
 *
 * The submodule carries source only — `dist/` is gitignored inside the engine repo too,
 * and the package's `exports` point at `./dist/index.js` — so a fresh clone must build it
 * before `npm install` can succeed here. Runs `git submodule update --init` first so this
 * also works right after `git clone` without `--recurse-submodules`.
 *
 * npm is invoked through its own JS entry point rather than the `npm`/`npm.cmd` shim,
 * mirroring the engine repo's `consumer-smoke/install-engine.mjs`: `execFileSync("npm", …)`
 * cannot launch `npm.cmd` on Windows, and spawning a `.cmd` without a shell fails with
 * EINVAL (the CVE-2024-27980 mitigation); `shell: true` fixes that and introduces DEP0190
 * (unescaped argument concatenation) instead. `npm_execpath` is set by npm for any script
 * it runs and points at `npm-cli.js`, so `node <npm-cli.js> …` sidesteps the shim entirely.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const enginePackagePath = join(repoRoot, "engine", "src", "engine");

const npmCli = process.env["npm_execpath"];
if (!npmCli) {
  throw new Error(
    "npm_execpath is unset — run this through `npm run setup`, not `node` directly",
  );
}

const runNpm = (args, options) =>
  execFileSync(process.execPath, [npmCli, ...args], {
    stdio: "inherit",
    ...options,
  });

if (!existsSync(join(enginePackagePath, "package.json"))) {
  console.log("Initializing engine submodule...");
  execFileSync("git", ["submodule", "update", "--init", "--recursive"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

console.log("Installing engine dependencies...");
runNpm(["ci"], { cwd: enginePackagePath });

console.log("Building engine package...");
runNpm(["run", "build"], { cwd: enginePackagePath });

console.log("Engine submodule ready.");
