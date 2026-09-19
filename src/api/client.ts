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
  const data =
    response.status === 204
      ? undefined
      : await response.json().catch(() => undefined);
  if (!response.ok)
    throw new ApiError(
      response.status,
      data?.error?.code ?? "request_failed",
      data,
    );
  if (data === undefined && response.status !== 204)
    throw new ApiError(response.status, "invalid_response");
  return data as T;
}
