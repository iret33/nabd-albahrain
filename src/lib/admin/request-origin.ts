/**
 * Header-derived facts about a request, shared by `src/middleware.ts` (Edge
 * runtime) and the login Server Action. Pure and runtime-neutral (no `next/*`,
 * no `node:*`) so it can be unit-tested and imported from the Edge bundle.
 *
 * Why the middleware cannot always trust `req.url`: Next builds it from the
 * server's BIND address, not from what the client asked for. A standalone
 * server started with `HOSTNAME=127.0.0.1` reports every request as
 * `http://localhost:<port>/...` (NextURL rewrites any 127.x.x.x host to
 * `localhost`), so `new URL("/admin/login", req.url)` sent visitors of
 * https://data.hekkapp.com/admin to https://localhost:3000/admin/login. A
 * relative `Location` cannot be written by hand either: the Edge adapter turns
 * it into `new NextURL(location)` and throws "Invalid URL" (a 500 on every
 * logged-out /admin hit). `requestOrigin()` therefore rebuilds the absolute
 * origin from the request's own `Host` (see `loginUrl()` in middleware.ts for
 * when that is needed).
 *
 * Trust model: `Host` is what the browser typed, so it is always honoured (a
 * forged one only redirects the forger's own request, and the response is
 * `no-store`). `X-Forwarded-Host` / `X-Forwarded-Proto` are honoured only when
 * TRUST_PROXY=1, exactly like `clientKey()` and the sync auth's origin check.
 * Every candidate is validated strictly; anything odd falls back to `req.url`.
 *
 * `isInsecureLoginRequest()` is the odd one out: it reads the browser's
 * `Origin` header instead, for the reason given on that function.
 */

type Env = Record<string, string | undefined>;

/** Anything with `get` — `Headers`, `NextRequest.headers`, or the read-only bag `next/headers` returns. */
export type HeaderBag = Pick<Headers, "get">;

/** First value of a possibly comma-separated (proxy-appended) header, trimmed; null when empty. */
export function firstHeaderValue(value: string | null | undefined): string | null {
  const first = value?.split(",")[0]?.trim();
  return first ? first : null;
}

export interface ParsedHost {
  /** Lower-cased hostname without brackets (an IPv6 literal keeps its colons). */
  hostname: string;
  /** The header value as given (lower-cased), safe to paste after `scheme://`. */
  host: string;
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const IPV6_LITERAL_RE = /^\[([0-9a-f:.]{2,45})\]$/;

/**
 * Strict `Host` parse: a DNS name / IPv4 address or a bracketed IPv6 literal,
 * with an optional numeric port. Rejects userinfo, paths, whitespace, empty
 * labels (`a..b`) and ports above 65535 — anything that could change the
 * meaning of `scheme://<host>`.
 */
export function parseHostHeader(raw: string | null | undefined): ParsedHost | null {
  const value = raw?.trim().toLowerCase();
  if (!value || value.length > 261) return null;

  let hostPart = value;
  let port: string | null = null;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return null;
    hostPart = value.slice(0, end + 1);
    const rest = value.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(":")) return null;
      port = rest.slice(1);
    }
    const literal = IPV6_LITERAL_RE.exec(hostPart);
    if (!literal || !literal[1].includes(":")) return null;
    if (port !== null && !validPort(port)) return null;
    return { hostname: literal[1], host: value };
  }

  const colon = value.indexOf(":");
  if (colon !== -1) {
    hostPart = value.slice(0, colon);
    port = value.slice(colon + 1);
    if (!validPort(port)) return null;
  }
  if (hostPart.length > 253 || !HOSTNAME_RE.test(hostPart)) return null;
  return { hostname: hostPart, host: value };
}

function validPort(port: string): boolean {
  return /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
}

/**
 * Hosts a browser treats as a secure context even over plain http, and
 * therefore the ones that accept a `Secure` cookie: `localhost`, `*.localhost`,
 * 127.0.0.0/8 and `::1`. Exact/CIDR matching only — `127.evil.com` and
 * `localhost.evil.com` are NOT loopback.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1") return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!octets) return false;
  const parts = octets.slice(1).map(Number);
  return parts.every((n) => n <= 255) && parts[0] === 127;
}

function trustProxy(env: Env): boolean {
  return env.TRUST_PROXY === "1";
}

/** The host the visitor addressed: X-Forwarded-Host (TRUST_PROXY=1 only), then Host. Null when neither parses. */
export function requestedHost(headers: HeaderBag, env: Env = process.env): ParsedHost | null {
  if (trustProxy(env)) {
    const forwarded = parseHostHeader(firstHeaderValue(headers.get("x-forwarded-host")));
    if (forwarded) return forwarded;
  }
  return parseHostHeader(firstHeaderValue(headers.get("host")));
}

/** `http` / `https` from X-Forwarded-Proto (TRUST_PROXY=1 only); null when absent, untrusted or unrecognised. */
export function forwardedProto(headers: HeaderBag, env: Env = process.env): "http" | "https" | null {
  if (!trustProxy(env)) return null;
  const proto = firstHeaderValue(headers.get("x-forwarded-proto"))?.toLowerCase();
  return proto === "http" || proto === "https" ? proto : null;
}

/**
 * `scheme://host[:port]` the visitor used, for building an absolute redirect.
 * Falls back to the origin of `fallbackUrl` (the request URL Next computed)
 * when the headers give nothing usable, so a malformed Host can never turn the
 * redirect into a thrown `Invalid URL`.
 */
export function requestOrigin(headers: HeaderBag, fallbackUrl: string | URL, env: Env = process.env): string {
  const fallback = new URL(fallbackUrl);
  const host = requestedHost(headers, env);
  if (!host) return fallback.origin;
  const fallbackProto = fallback.protocol === "https:" ? "https" : "http";
  return `${forwardedProto(headers, env) ?? fallbackProto}://${host.host}`;
}

/**
 * Positive evidence that the admin login form was submitted from a page served
 * over plain http on a non-loopback host, where the browser will drop the
 * `Secure` / `__Host-` session cookie.
 *
 * The evidence is the browser's own `Origin` header on the POST (it names the
 * page's real scheme and host whatever sits in between, so no proxy header and
 * no TRUST_PROXY is involved). `X-Forwarded-Proto` is deliberately NOT used:
 * Next fabricates `x-forwarded-proto: http` on every request that arrives
 * without one (base-server.js), so inside a Server Action it cannot tell "the
 * proxy says http" from "the proxy sent nothing", and trusting it would lock
 * every production login out behind a proxy that terminates TLS but does not
 * forward the header (default nginx). Fail-open on anything else: no Origin, an
 * unparsable one, `null`, https, or a loopback host all mean "no evidence".
 */
export function isInsecureLoginRequest(headers: HeaderBag): boolean {
  const raw = firstHeaderValue(headers.get("origin"));
  if (!raw) return false;
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    return false;
  }
  if (origin.protocol !== "http:") return false;
  const hostname = origin.hostname.replace(/^\[|\]$/g, ""); // URL keeps the brackets of an IPv6 literal
  return !isLoopbackHostname(hostname);
}
