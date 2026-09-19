import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const image = process.env.FRONTEND_TEST_IMAGE ?? "adventures-web:test";
const name = `adventures-web-test-${randomUUID()}`;
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();
try {
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--read-only",
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
  execFileSync(process.execPath, ["--test", "frontend/hosting.test.mjs"], {
    stdio: "inherit",
    env: { ...process.env, HOSTING_URL: `http://${address}` },
  });
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
