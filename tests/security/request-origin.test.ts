import { describe, expect, it } from "vitest";
import {
  firstHeaderValue,
  isInsecureLoginRequest,
  isLoopbackHostname,
  parseHostHeader,
  requestOrigin,
  requestedHost,
} from "@/lib/admin/request-origin";

const h = (init: Record<string, string>) => new Headers(init);
const TRUSTED = { TRUST_PROXY: "1" };
const UNTRUSTED = { TRUST_PROXY: "0" };

describe("firstHeaderValue", () => {
  it("takes the first comma-separated value, trimmed", () => {
    expect(firstHeaderValue("https, http")).toBe("https");
    expect(firstHeaderValue("  a.example , b.example")).toBe("a.example");
    expect(firstHeaderValue("")).toBeNull();
    expect(firstHeaderValue(" , x")).toBeNull();
    expect(firstHeaderValue(null)).toBeNull();
    expect(firstHeaderValue(undefined)).toBeNull();
  });
});

describe("parseHostHeader", () => {
  it("accepts DNS names, IPv4 and bracketed IPv6, with an optional port", () => {
    expect(parseHostHeader("data.hekkapp.com")).toEqual({ hostname: "data.hekkapp.com", host: "data.hekkapp.com" });
    expect(parseHostHeader("Data.HekkApp.com:8443")).toEqual({ hostname: "data.hekkapp.com", host: "data.hekkapp.com:8443" });
    expect(parseHostHeader("127.0.0.1:3000")?.hostname).toBe("127.0.0.1");
    expect(parseHostHeader("localhost")?.hostname).toBe("localhost");
    expect(parseHostHeader("[::1]:3000")).toEqual({ hostname: "::1", host: "[::1]:3000" });
    expect(parseHostHeader("[2001:db8::1]")?.hostname).toBe("2001:db8::1");
  });

  it("rejects anything that could change the meaning of scheme://<host>", () => {
    for (const bad of [
      "",
      "   ",
      null,
      undefined,
      "user@evil.example",
      "evil.example/path",
      "evil.example?x=1",
      "evil.example#x",
      "bad host",
      "evil.example:",
      "evil.example:0",
      "evil.example:65536",
      "evil.example:99999999",
      "evil.example:80:80",
      "a..b",
      "-lead.example",
      "trail-.example",
      "[::1",
      "[::1]x",
      "[abc]",
      "[::1]:99999",
      "evil.example\r\nX: 1",
      "a".repeat(300),
      "موقع.example",
    ]) {
      expect(parseHostHeader(bad), String(bad)).toBeNull();
    }
  });
});

describe("isLoopbackHostname (exact / CIDR, never prefix or substring)", () => {
  it("accepts localhost, *.localhost, 127.0.0.0/8 and ::1", () => {
    for (const ok of ["localhost", "LOCALHOST", "app.localhost", "localhost.", "127.0.0.1", "127.255.255.254", "127.1.2.3", "::1"]) {
      expect(isLoopbackHostname(ok), ok).toBe(true);
    }
  });

  it("rejects look-alikes and other private ranges", () => {
    for (const bad of [
      "127.evil.com",
      "localhost.evil.com",
      "evil-localhost",
      "notlocalhost",
      "128.0.0.1",
      "10.0.0.1",
      "192.168.1.1",
      "0.0.0.0",
      "127.0.0.256",
      "127.0.0",
      "1270.0.0.1",
      "::2",
      "data.hekkapp.com",
    ]) {
      expect(isLoopbackHostname(bad), bad).toBe(false);
    }
  });
});

describe("requestedHost", () => {
  it("prefers X-Forwarded-Host only when TRUST_PROXY=1", () => {
    const headers = h({ host: "10.0.0.5:3000", "x-forwarded-host": "data.hekkapp.com, proxy.internal" });
    expect(requestedHost(headers, TRUSTED)?.host).toBe("data.hekkapp.com");
    expect(requestedHost(headers, UNTRUSTED)?.host).toBe("10.0.0.5:3000");
    expect(requestedHost(headers, {})?.host).toBe("10.0.0.5:3000");
  });

  it("falls through an unusable forwarded host to Host", () => {
    expect(requestedHost(h({ host: "data.hekkapp.com", "x-forwarded-host": "bad host" }), TRUSTED)?.host).toBe("data.hekkapp.com");
  });

  it("is null when nothing parses", () => {
    expect(requestedHost(h({}), TRUSTED)).toBeNull();
    expect(requestedHost(h({ host: "a b" }), TRUSTED)).toBeNull();
  });
});

describe("requestOrigin", () => {
  const bindUrl = "http://localhost:3204/admin";

  it("uses the visitor's Host, not the server's bind address", () => {
    expect(requestOrigin(h({ host: "data.hekkapp.com" }), bindUrl, UNTRUSTED)).toBe("http://data.hekkapp.com");
  });

  it("takes scheme and host from the forwarded headers under TRUST_PROXY=1 (first value only, case-insensitive)", () => {
    const headers = h({ host: "127.0.0.1:3204", "x-forwarded-proto": "HTTPS, http", "x-forwarded-host": "data.hekkapp.com" });
    expect(requestOrigin(headers, bindUrl, TRUSTED)).toBe("https://data.hekkapp.com");
  });

  it("ignores forwarded headers without TRUST_PROXY and keeps the request URL's scheme", () => {
    const headers = h({ host: "192.168.1.20:8080", "x-forwarded-proto": "https", "x-forwarded-host": "evil.example" });
    expect(requestOrigin(headers, bindUrl, UNTRUSTED)).toBe("http://192.168.1.20:8080");
    expect(requestOrigin(headers, "https://localhost:3204/admin", UNTRUSTED)).toBe("https://192.168.1.20:8080");
  });

  it("only ever emits http or https", () => {
    for (const proto of ["javascript", "ftp", "https://evil", ""]) {
      const origin = requestOrigin(h({ host: "data.hekkapp.com", "x-forwarded-proto": proto }), bindUrl, TRUSTED);
      expect(origin).toBe("http://data.hekkapp.com");
    }
  });

  it("falls back to the request URL's origin when Host is missing or hostile", () => {
    for (const host of [undefined, "", "evil.example/../x", "user@evil.example", "evil.example:99999"]) {
      const headers = host === undefined ? h({}) : h({ host });
      expect(requestOrigin(headers, bindUrl, TRUSTED)).toBe("http://localhost:3204");
    }
  });

  it("always yields something `new URL` accepts for a login path", () => {
    for (const host of ["data.hekkapp.com", "[::1]:3000", "127.0.0.1:3204", "x"]) {
      expect(new URL("/admin/login", requestOrigin(h({ host }), bindUrl, TRUSTED)).pathname).toBe("/admin/login");
    }
  });
});

describe("isInsecureLoginRequest (positive evidence only: the browser's Origin)", () => {
  it("flags a form posted from an http page on a non-loopback host", () => {
    for (const origin of [
      "http://192.0.2.2:3000",
      "http://192.168.1.20",
      "http://data.hekkapp.com",
      "HTTP://Data.HekkApp.com:8080",
      "http://127.evil.com", // not 127.0.0.0/8
      "http://localhost.evil.com",
      "http://[2001:db8::1]:3000",
    ]) {
      expect(isInsecureLoginRequest(h({ origin })), origin).toBe(true);
    }
  });

  it("does NOT flag https or loopback origins (a secure context: the browser keeps a Secure cookie)", () => {
    for (const origin of [
      "https://data.hekkapp.com",
      "https://192.0.2.2:3000",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://127.255.0.2",
      "http://app.localhost:3000",
      "http://[::1]:3000",
    ]) {
      expect(isInsecureLoginRequest(h({ origin })), origin).toBe(false);
    }
  });

  it("fails open on anything that is not clear evidence (no lockout from a missing or odd header)", () => {
    for (const origin of [undefined, "", "null", "not a url", "ftp://192.0.2.2", "//192.0.2.2", "http://"]) {
      expect(isInsecureLoginRequest(origin === undefined ? h({}) : h({ origin })), String(origin)).toBe(false);
    }
  });

  it("ignores X-Forwarded-Proto and Host entirely: Next invents `x-forwarded-proto: http` on requests that carry none", () => {
    // What a Server Action sees behind a TLS-terminating proxy that forwards no X-Forwarded-Proto
    // (default nginx): Next's base-server adds x-forwarded-proto: http and x-forwarded-host: <Host>.
    const injected = h({ host: "data.hekkapp.com", "x-forwarded-proto": "http", "x-forwarded-host": "data.hekkapp.com" });
    expect(isInsecureLoginRequest(injected)).toBe(false);
    // ...and with the browser's real https Origin it stays false, whatever the injected header says.
    expect(isInsecureLoginRequest(h({ origin: "https://data.hekkapp.com", "x-forwarded-proto": "http" }))).toBe(false);
  });
});
