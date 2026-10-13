#!/usr/bin/env node
// Checks real container routing, assets, health and revision of the frontend image.
//
// Two ways to run it:
//   - Against a container that is already running -- container.yml's smoke step starts the
//     image and sets IMAGE, CONTAINER and SMOKE_URL. The container is left for that step
//     to stop; the expected revision comes from the image's own revision label.
//   - On its own (`FRONTEND_TEST_IMAGE=... node scripts/test-frontend-container.mjs`): it
//     starts the image with the restrictions the deployment stack applies, waits for its
//     health check, runs the checks and removes the container.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();

function runHostingTests(url, expectedRevision) {
  execFileSync(process.execPath, ["--test", "frontend/hosting.test.mjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      HOSTING_URL: url,
      ...(expectedRevision && { EXPECTED_BUILD_REVISION: expectedRevision }),
    },
  });
}

if (process.env.CONTAINER) {
  const url = process.env.SMOKE_URL;
  if (!url) throw new Error("SMOKE_URL is not set for the running container");
  // The workflow builds with ADVENTURES_BUILD_REVISION=<commit>, which the Dockerfile
  // writes to /__build-id and to this label.
  const revision =
    process.env.EXPECTED_BUILD_REVISION ??
    docker(
      "image",
      "inspect",
      "--format",
      '{{ index .Config.Labels "org.opencontainers.image.revision" }}',
      process.env.IMAGE,
    );
  runHostingTests(url, revision);
} else {
  const image = process.env.FRONTEND_TEST_IMAGE ?? "adventures-web:test";
  const name = `adventures-web-test-${randomUUID()}`;
  try {
    docker(
      "run",
      "-d",
      "--name",
      name,
      // The same restrictions the deployment stack applies, so CI exercises what runs.
      "--read-only",
      "--tmpfs=/var/run:rw,mode=1777",
      "--tmpfs=/var/cache/nginx:rw,mode=1777",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "-p",
      "127.0.0.1::8080",
      image,
    );
    const address = docker("port", name, "8080/tcp").split("\n")[0];
    let healthy = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const status = docker(
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        name,
      );
      if (status === "healthy") {
        healthy = true;
        break;
      }
      if (status === "unhealthy") break;
      await setTimeout(1000);
    }
    if (!healthy) throw new Error("Frontend container did not become healthy");
    runHostingTests(`http://${address}`, process.env.EXPECTED_BUILD_REVISION);
  } catch (error) {
    try {
      console.error(docker("logs", name));
    } catch {
      /* No container if startup failed. */
    }
    throw error;
  } finally {
    try {
      docker("rm", "-f", name);
    } catch {
      /* Only remove this test's container. */
    }
  }
}
