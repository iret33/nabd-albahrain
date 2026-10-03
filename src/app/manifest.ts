import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/seo";

/**
 * Web app manifest (served at /manifest.webmanifest): makes the site
 * installable and sets the browser chrome colors. Arabic name, right-to-left,
 * standalone. Colors are the design tokens (sea-900, sand-50).
 *
 * The icons are the `icon1.png` (192) / `icon2.png` (512) files next to this
 * one. The mark sits inside the central 70% of the full-bleed art, so each
 * file works as both a regular and a maskable icon (Android crops it to a
 * circle/squircle without cutting the mark).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE_NAME} — لوحة بيانات البحرين المفتوحة`,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    lang: "ar",
    dir: "rtl",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f7f3ec",
    theme_color: "#0b2027",
    categories: ["government", "data", "education"],
    icons: [
      { src: "/icon1.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon2.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon2.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
