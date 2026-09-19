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
  it("accepts a bodyless success while still rejecting a malformed body", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    // A write that answers with no content is legitimate, not an invalid response --
    // 204 and a bare 200 alike.
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(request("https://api.example", "/delete")).resolves.toBe(
      undefined,
    );
    fetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    await expect(request("https://api.example", "/publish")).resolves.toBe(
      undefined,
    );
    // A body that is present but will not parse still is.
    fetch.mockResolvedValueOnce(new Response("<html>502</html>"));
    await expect(request("https://api.example", "/read")).rejects.toMatchObject(
      { code: "invalid_response" },
    );
    // And an error whose body is not JSON keeps the raw text diagnostic.
    fetch.mockResolvedValueOnce(
      new Response("upstream exploded", { status: 500 }),
    );
    await expect(request("https://api.example", "/read")).rejects.toMatchObject(
      {
        status: 500,
        code: "request_failed",
        detail: "upstream exploded",
      },
    );
  });
});
