/**
 * A `fetch` that refuses to reach anything on a private, loopback, or link-local network --
 * the guard a player-submitted URL source needs and an admin-added one does not (an admin is
 * already a trusted operator; a player is not, and this server sits on the same Docker network
 * as its own database and other unrelated containers on the shared `proxy-net`). Resolves the
 * hostname itself and checks the *resolved* address rather than the literal hostname, so a DNS
 * name that merely points at an internal address is caught the same as a literal IP would be;
 * refuses to follow a redirect rather than re-validating its target, since the target is
 * attacker-chosen either way; and caps the response body instead of trusting `Content-Length`,
 * which a malicious or merely misbehaving server is free to omit or understate.
 *
 * Known gap, deliberately not closed here: this checks the address *before* connecting, not
 * the address the TCP stack actually connects to -- a DNS answer that changes between the
 * check and the fetch (DNS rebinding) is not caught. Closing that fully means pinning the
 * resolved address into the connection itself (a custom `dns.lookup` on a per-request
 * `undici.Agent`), which is real additional plumbing; the pre-connect check here still closes
 * the ordinary case (a literal internal URL, or a stable internal DNS name) with no extra
 * infrastructure, and is judged proportionate to what admin-only URL sources needed before.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n)))
    return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local, including cloud metadata endpoints
  if (a === 0) return true; // "this network"
  return false;
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (/^fe[89ab]/.test(normalized)) return true; // link-local, fe80::/10
  if (/^f[cd]/.test(normalized)) return true; // unique local, fc00::/7
  const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mappedV4) return isPrivateIPv4(mappedV4[1]!);
  return false;
}

async function assertPublicHost(hostname: string): Promise<void> {
  const { address } = await lookup(hostname);
  const version = isIP(address);
  const isPrivate =
    version === 4
      ? isPrivateIPv4(address)
      : version === 6
        ? isPrivateIPv6(address)
        : true; // not a recognizable literal address at all -- refuse rather than guess
  if (isPrivate) {
    throw new UnsafeUrlError(
      `refusing to fetch ${hostname}: resolves to a private or reserved address`,
    );
  }
}

/** A drop-in for the global `fetch` that `createHttpCampaignSource` can be handed instead of
 *  its default. https-only, no redirects, and a capped response body -- see this file's
 *  header for what each guards against and what remains a known gap. */
export async function safeFetch(
  url: string | URL,
  init: { readonly signal: AbortSignal },
): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new UnsafeUrlError(`refusing a non-https URL`);
  }
  await assertPublicHost(parsed.hostname);

  const response = await fetch(parsed, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    throw new UnsafeUrlError(`refusing to follow a redirect`);
  }

  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null && Number(lengthHeader) > MAX_RESPONSE_BYTES) {
    throw new UnsafeUrlError(
      `response exceeds the ${MAX_RESPONSE_BYTES}-byte limit`,
    );
  }
  if (!response.body) return response;

  // The cap is enforced here too, not just against the header above -- a server is free to
  // omit or understate Content-Length, and this is what actually bounds memory use either way.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new UnsafeUrlError(
        `response exceeds the ${MAX_RESPONSE_BYTES}-byte limit`,
      );
    }
    chunks.push(value);
  }
  return new Response(new Blob(chunks), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
