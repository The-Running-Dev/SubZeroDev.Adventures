// Guards against this repo and SubZeroDev.Platform silently drifting onto two different
// copies of the same-named contract artifact (issue #13) -- there is no shared CI between
// the two repos to compare against live, so this pins the sha256 Platform's own
// `workloads/game-service/vendor/subzerodev-service-contract-0.2.0.tgz` had as of the last
// time someone checked the two side by side. Bumping the vendored tarball here requires
// updating EXPECTED_SHA256 in the same commit, deliberately -- that is the point at which
// a human re-confirms Platform vendored the identical file, not a different build of the
// same version.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const EXPECTED_SHA256 =
  "80505020e74a521dda0e0cb182ff3952714391a4170f242115e29e2b9a9b8feb";

const artifactUrl = new URL(
  "../vendor/subzerodev-service-contract-0.2.0.tgz",
  import.meta.url,
);
const bytes = await readFile(artifactUrl);
const actual = createHash("sha256").update(bytes).digest("hex");

if (actual !== EXPECTED_SHA256) {
  throw new Error(
    `server/vendor/subzerodev-service-contract-0.2.0.tgz has sha256 ${actual}, expected ${EXPECTED_SHA256} -- ` +
      "this no longer matches the copy SubZeroDev.Platform vendors. Re-verify the two repos " +
      "reference the identical artifact, then update EXPECTED_SHA256 in this script.",
  );
}

console.log("contract artifact sha256 matches Platform's vendored copy.");
