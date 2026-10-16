/**
 * The liveness/readiness split (issue #9, stage 3). No database: the pool is a stand-in
 * whose `select 1` answers, fails or hangs, which is all the probes ask of it.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { ContentCell, ContentStatus } from "./content-cell.js";
import { registerHealthRoute } from "./health.js";

function poolThat(answers: boolean | "hangs"): {
  pool: Pool;
  queries: () => number;
} {
  let count = 0;
  const pool = {
    query: () => {
      count += 1;
      if (answers === "hangs") return new Promise(() => {});
      return answers
        ? Promise.resolve({ rows: [{ "?column?": 1 }] })
        : Promise.reject(new Error("connect ECONNREFUSED"));
    },
  } as unknown as Pool;
  return { pool, queries: () => count };
}

function cellWith(status: Partial<ContentStatus>): ContentCell {
  return {
    current: () => {
      throw new Error("the health routes never read the catalog");
    },
    status: () =>
      ({
        campaignCount: 1,
        coreCampaignCount: 1,
        bootstrapFallback: false,
        ...status,
      }) as ContentStatus,
  } as unknown as ContentCell;
}

describe("health routes", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  async function serve(
    pool: Pool,
    cell: ContentCell = cellWith({}),
    databaseTimeoutMs?: number,
  ) {
    app = Fastify();
    registerHealthRoute(app, pool, cell, databaseTimeoutMs);
    await app.ready();
  }

  it("answers liveness without touching the database, even when it is down", async () => {
    const { pool, queries } = poolThat(false);
    await serve(pool);

    const response = await app.inject({ method: "GET", url: "/livez" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(queries()).toBe(0);
  });

  it("is ready when the database answers", async () => {
    await serve(poolThat(true).pool);

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("is not ready when the database does not answer", async () => {
    await serve(poolThat(false).pool);

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false });
  });

  it("is not ready when the database stops answering, rather than hanging", async () => {
    // A paused or partitioned Postgres neither answers nor refuses.
    await serve(poolThat("hangs").pool, cellWith({}), 50);

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false });
  });

  it("stays ready when only a content refresh has failed", async () => {
    // Degraded is `/healthz`'s business: the previous catalog is still serving.
    await serve(
      poolThat(true).pool,
      cellWith({
        lastSuccessAt: "2026-10-17T10:00:00.000Z",
        lastFailureAt: "2026-10-17T11:00:00.000Z",
        lastError: "refresh failed",
      }),
    );

    const ready = await app.inject({ method: "GET", url: "/readyz" });
    const health = await app.inject({ method: "GET", url: "/healthz" });

    expect(ready.statusCode).toBe(200);
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, degraded: true });
  });

  it("keeps /healthz's answer when the database is down", async () => {
    await serve(poolThat(false).pool);

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false });
  });
});
