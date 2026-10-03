import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";

type Rule = { source: string; headers: Array<{ key: string; value: string }> };

async function rules(): Promise<Rule[]> {
  return (await nextConfig.headers!()) as Rule[];
}
const headerMap = (rule: Rule) => Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));
const forAll = async () => headerMap((await rules()).find((r) => r.source === "/:path*")!);

afterEach(() => vi.unstubAllEnvs());

describe("next.config.ts security configuration", () => {
  it("hides X-Powered-By and disables the image optimizer endpoint", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    expect(nextConfig.images?.unoptimized).toBe(true);
  });

  it("sends the baseline headers on every path in every environment", async () => {
    for (const env of ["development", "production"]) {
      vi.stubEnv("NODE_ENV", env);
      const h = await forAll();
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
      expect(h["X-Frame-Options"]).toBe("DENY");
      expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
      for (const feature of ["camera=()", "microphone=()", "geolocation=()", "payment=()", "interest-cohort=()"]) {
        expect(h["Permissions-Policy"]).toContain(feature);
      }
    }
  });

  it("adds HSTS and a strict CSP only in production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const dev = await forAll();
    expect(dev["Content-Security-Policy"]).toBeUndefined();
    expect(dev["Strict-Transport-Security"]).toBeUndefined();

    vi.stubEnv("NODE_ENV", "production");
    const prod = await forAll();
    expect(prod["Strict-Transport-Security"]).toBe("max-age=31536000");
    const directives = Object.fromEntries(
      prod["Content-Security-Policy"].split(";").map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values];
      }),
    );
    expect(directives["default-src"]).toEqual(["'self'"]);
    expect(directives["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives["img-src"]).toEqual(["'self'", "data:", "blob:"]);
    expect(directives["font-src"]).toEqual(["'self'", "data:"]);
    expect(directives["connect-src"]).toEqual(["'self'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
    expect(directives["base-uri"]).toEqual(["'self'"]);
    expect(directives["form-action"]).toEqual(["'self'"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    // No eval, no wildcard or remote origin anywhere.
    expect(prod["Content-Security-Policy"]).not.toMatch(/unsafe-eval|\*|https?:/);
    // No includeSubDomains: other services share the parent domain.
    expect(prod["Strict-Transport-Security"]).not.toContain("includeSubDomains");
  });

  it("keeps /admin out of caches and indexes", async () => {
    const admin = (await rules()).find((r) => r.source === "/admin/:path*")!;
    expect(headerMap(admin)).toMatchObject({ "Cache-Control": "no-store" });
    expect(headerMap(admin)["X-Robots-Tag"]).toContain("noindex");
  });

  it("does not cache sync API responses", async () => {
    const sync = (await rules()).find((r) => r.source === "/api/sync/:path*")!;
    expect(headerMap(sync)["Cache-Control"]).toBe("no-store");
  });
});
