import { cp, mkdir } from "node:fs/promises";
const destination = new URL(
  "../dist/shared/offline/runtimes/",
  import.meta.url,
);
await mkdir(destination, { recursive: true });
await cp(
  new URL("../../shared/offline/runtimes/", import.meta.url),
  destination,
  { recursive: true },
);
