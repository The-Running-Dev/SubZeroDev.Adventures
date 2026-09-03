// Guards against this repo silently drifting onto a different build of the same-named
// contract artifact it thinks it vendored (issue #13) -- there is no shared CI between
// this repo and SubZeroDev.Platform to compare against live, so this pins the sha256 the
// vendored tarball is expected to have. Bumping the vendored tarball requires updating
// EXPECTED_SHA256 in the same commit, deliberately -- that is the point at which whoever
// makes the change confirms the file they committed is the one they meant to.
//
// KNOWN DIVERGENCE (2026-09-03): this repo now vendors 0.6.0; SubZeroDev.Platform's own
// `workloads/game-service/vendor/` was last confirmed at 0.5.0 (issue #13's original
// cross-repo parity this guard existed to protect). The two are not currently
// byte-identical. Re-verify against Platform's copy once it bumps to 0.6.0 or later, and
// restore this comment's original claim that EXPECTED_SHA256 matches Platform's vendored
// copy -- until then, this only proves this repo's own file is the one it meant to commit.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const EXPECTED_SHA256 =
  "41afbe946a6f96fa65339994800afaa5f4164c80628a5cba8d6c5fd84aafb175";

const artifactUrl = new URL(
  "../vendor/subzerodev-service-contract-0.6.0.tgz",
  import.meta.url,
);
const bytes = await readFile(artifactUrl);
const actual = createHash("sha256").update(bytes).digest("hex");

if (actual !== EXPECTED_SHA256) {
  throw new Error(
    `server/vendor/subzerodev-service-contract-0.6.0.tgz has sha256 ${actual}, expected ${EXPECTED_SHA256} -- ` +
      "this no longer matches the file this repo committed. Re-verify what changed, then " +
      "update EXPECTED_SHA256 in this script.",
  );
}

console.log("contract artifact sha256 matches the pinned value.");
