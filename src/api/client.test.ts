import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, request } from "./client";
afterEach(() => vi.unstubAllGlobals());
describe("API transport", () => {
  it("includes private credentials and explicitly omits them for public data", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await request("https://api.example/", "/api/campaigns");
    expect(fetch).toHaveBeenLastCalledWith(
      "https://api.example/api/campaigns",
      expect.objectContaining({ credentials: "include" }),
    );
    fetch.mockResolvedValueOnce(Response.json({ ok: true }));
    await request("https://api.example", "/api/stats", { public: true });
    expect(fetch).toHaveBeenLastCalledWith(
      "https://api.example/api/stats",
      expect.objectContaining({ credentials: "omit" }),
    );
  });
  it("retains structured error codes while keeping raw server text diagnostic", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { code: "forbidden", message: "diagnostic" } },
            { status: 403 },
          ),
        ),
    );
    await expect(
      request("https://api.example", "/private"),
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      detail: { error: { message: "diagnostic" } },
    });
  });
  it("rejects failed or malformed responses without retrying mutations", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetch);
    await expect(
      request("https://api.example", "/write", {
        method: "POST",
        body: { value: 1 },
      }),
    ).rejects.toMatchObject({ code: "network_error" });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(new Response("not JSON"));
    await expect(
      request("https://api.example", "/read"),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
