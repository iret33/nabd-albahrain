import type { Metadata, Viewport } from "next";
import { Tajawal, IBM_Plex_Sans_Arabic } from "next/font/google";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { SITE_URL } from "@/lib/site";
import {
  DEFAULT_TITLE,
  SITE_DESCRIPTION,
  SITE_NAME,
  THEME_COLOR,
  TITLE_TEMPLATE,
  alternatesFor,
} from "@/lib/seo";
import "./globals.css";

/**
 * Every page renders the footer's freshness line (a database read behind the
 * cached data layer), so no route under this layout can be prerendered at
 * `next build` time: that needs a live DATABASE_URL, which a Docker/CI build
 * must never depend on (see the longer note on `src/app/(home)/page.tsx`).
 * Declaring it once here covers the static-looking routes too (/about, the 404).
 */
export const dynamic = "force-dynamic";

const tajawal = Tajawal({
  variable: "--font-tajawal",
  subsets: ["arabic", "latin"],
  weight: ["700", "900"],
  display: "swap",
});

const ibmPlexSansArabic = IBM_Plex_Sans_Arabic({
  variable: "--font-ibm-plex-sans-arabic",
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

/**
 * Defaults every page inherits. `title.template` appends the site name, so
 * pages set only their own title. Next merges metadata shallowly per top-level
 * key, so a page that sets `alternates` or `openGraph` replaces these wholesale
 * (see `src/lib/seo.ts`, which rebuilds them with the shared fields). The
 * brand image comes from the `opengraph-image` / `twitter-image` file
 * conventions in this folder and applies to every route.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: DEFAULT_TITLE, template: TITLE_TEMPLATE },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: alternatesFor("./"),
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    locale: "ar_BH",
    title: DEFAULT_TITLE,
    description: SITE_DESCRIPTION,
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: THEME_COLOR,
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ar"
      dir="rtl"
      className={`${tajawal.variable} ${ibmPlexSansArabic.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-sand-50 text-ink">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-sea-900 focus:px-5 focus:py-3 focus:text-sm focus:font-bold focus:text-sand-50 focus-visible:outline-pearl"
        >
          تخطَّ إلى المحتوى
        </a>
        <SiteHeader />
        {/* tabIndex -1: the skip link moves focus here; no outline on a programmatic focus target. */}
        <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
