export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: unknown;
  constructor(status: number, code: string, detail?: unknown) {
    super(`${status} (${code})`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  public?: boolean;
}

/** Ordinary HTTP only: no mutation replay, retries, persistence or game execution. */
export async function request<T>(
  baseUrl: string | undefined,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  if (!baseUrl) throw new ApiError(0, "not_configured");
  const { body, public: isPublic = false, ...init } = options;
  const headers = new Headers(init.headers);
  if (body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      credentials: isPublic ? "omit" : "include",
      headers,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
          }),
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError(0, "network_error", error);
  }
  // Read as text first so an empty body and a malformed one stay distinguishable. A
  // bodyless success is legitimate (204, and any route that answers a write with no
  // content); a non-empty body that will not parse is not, and only the second is an
  // `invalid_response`.
  const text = response.status === 204 ? "" : await response.text();
  let data: unknown;
  let parsed = text === "";
  if (!parsed) {
    try {
      data = JSON.parse(text);
      parsed = true;
    } catch {
      data = undefined;
    }
  }
  if (!response.ok) {
    const code = (data as { error?: { code?: string } } | undefined)?.error
      ?.code;
    throw new ApiError(
      response.status,
      code ?? "request_failed",
      parsed ? data : text,
    );
  }
  if (!parsed) throw new ApiError(response.status, "invalid_response", text);
  return data as T;
}
