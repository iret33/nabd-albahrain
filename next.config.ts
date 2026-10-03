import type { NextConfig } from "next";
import path from "node:path";

/**
 * Content-Security-Policy, production only (the dev server needs `eval` and a
 * websocket for HMR). 'unsafe-inline' for scripts is the price of Next's
 * hydration payload (`self.__next_f.push(...)` inline scripts) without a
 * per-request nonce — a nonce would force every route to render dynamically.
 * Styles need it for Recharts and React `style={{...}}` props. Everything else
 * is same-origin: the fonts are local files (`src/app/fonts`, emitted under
 * `/_next/static/media` by `next/font/local`, no font host is contacted at
 * build or run time), there is no third-party script, image or XHR, and
 * `<script type="application/ld+json">` is non-executable data that CSP does
 * not govern.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the workspace root to this project — the user's home directory
  // happens to contain an unrelated package.json/lockfile from other work,
  // which Next.js would otherwise mistake for the monorepo root.
  outputFileTracingRoot: path.join(__dirname),
  // Don't advertise the framework.
  poweredByHeader: false,
  // The app has no next/image usage and no remote image sources. Turning the
  // optimizer off removes the public /_next/image endpoint (a sharp/libvips
  // attack surface that has had critical advisories) — it answers 404 BEFORE
  // sharp is ever required. sharp still ships in node_modules as Next's optional
  // dependency, and `pnpm audit --prod` lists high advisories for old versions
  // of it; they are unreachable only because of this setting, so do not enable
  // the optimizer without first bumping sharp (see the Dockerfile and CI audit
  // notes). tests/security/headers.test.ts pins it.
  images: { unoptimized: true },
  async headers() {
    // Read at call time (not module load) so the policy follows the real
    // build/start mode and tests can exercise both.
    const isProd = process.env.NODE_ENV === "production";
    const baseline = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()",
      },
      // No includeSubDomains: the parent domain hosts other services whose
      // HTTPS status this app cannot vouch for.
      ...(isProd
        ? [
            { key: "Strict-Transport-Security", value: "max-age=31536000" },
            { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
          ]
        : []),
    ];
    return [
      { source: "/:path*", headers: baseline },
      // Authenticated, per-admin pages: never cached by a browser/proxy, never indexed.
      {
        source: "/admin/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      // Sync status/trigger responses carry run errors and lock state.
      { source: "/api/sync/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
