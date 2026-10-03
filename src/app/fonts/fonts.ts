import localFont from "next/font/local";

/**
 * Self-hosted web fonts (R6-07). The production build used `next/font/google`,
 * which downloads the families from fonts.googleapis.com at `next build` time
 * and hard-fails when that host is unreachable (CI behind an egress allowlist,
 * a Google outage, a TLS-intercepting proxy). The woff2 files now live next to
 * this module, so a build touches no font host. They are the files Google Fonts
 * serves to a current browser (fetched once from fonts.gstatic.com), and both
 * families are licensed under the SIL Open Font License 1.1 (the license texts
 * sit beside the files: `OFL-Tajawal.txt`, `OFL-IBM-Plex-Sans-Arabic.txt`).
 * Everything is emitted under `/_next/static/media`, so `font-src 'self'` holds.
 *
 * Why one `localFont()` per subset rather than one call with a `src` array:
 * Google's CSS slices each weight into `unicode-range` faces (arabic, latin,
 * latin-ext) of ONE family, but `next/font/local` applies the same declarations
 * to every face of a call. Faces of one family and weight without a
 * `unicode-range` shadow each other (the last one wins, and the glyphs it lacks
 * fall through to the system font, so Arabic text would render in Arial). Each
 * subset therefore gets its own family with its own `unicode-range`, and
 * `globals.css` chains them into one font stack (`--font-tajawal`,
 * `--font-ibm-plex-sans-arabic`: Latin first, then Arabic), so every character
 * resolves to the same file it did before. The ranges are copied verbatim from
 * Google's CSS; Next only accepts literals in these calls, hence the repetition.
 *
 * The metric-adjusted Arial fallback faces ("Tajawal Fallback", "IBM Plex Sans
 * Arabic Fallback", which keep text from jumping when the web font swaps in) are
 * declared by hand in `globals.css`, with the values the Google loader had
 * computed for these two families, and sit LAST in each stack. One that Next
 * generated for the Latin family would come before the Arabic one and answer
 * Arabic characters itself (Arial has them), and one generated from a subset file
 * without Latin glyphs gets a wrong size adjustment. So every call here sets
 * `adjustFontFallback: false`.
 * Cyrillic is not shipped (no dataset text needs it, and it falls back to the
 * system font like any other missing glyph).
 *
 * `preload` is on for the arabic and latin files (needed on every page, as the
 * Google loader preloaded them) and off for latin-ext, which only a few
 * accented names use.
 */

export const tajawalLatin = localFont({
  src: [
    { path: "./tajawal-latin-700.woff2", weight: "700", style: "normal" },
    { path: "./tajawal-latin-900.woff2", weight: "900", style: "normal" },
  ],
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  display: "swap",
  variable: "--font-tajawal-latin",
  adjustFontFallback: false,
});

export const tajawalArabic = localFont({
  src: [
    { path: "./tajawal-arabic-700.woff2", weight: "700", style: "normal" },
    { path: "./tajawal-arabic-900.woff2", weight: "900", style: "normal" },
  ],
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0897-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC, U+102E0-102FB, U+10E60-10E7E, U+10EC2-10EC4, U+10EFC-10EFF, U+1EE00-1EE03, U+1EE05-1EE1F, U+1EE21-1EE22, U+1EE24, U+1EE27, U+1EE29-1EE32, U+1EE34-1EE37, U+1EE39, U+1EE3B, U+1EE42, U+1EE47, U+1EE49, U+1EE4B, U+1EE4D-1EE4F, U+1EE51-1EE52, U+1EE54, U+1EE57, U+1EE59, U+1EE5B, U+1EE5D, U+1EE5F, U+1EE61-1EE62, U+1EE64, U+1EE67-1EE6A, U+1EE6C-1EE72, U+1EE74-1EE77, U+1EE79-1EE7C, U+1EE7E, U+1EE80-1EE89, U+1EE8B-1EE9B, U+1EEA1-1EEA3, U+1EEA5-1EEA9, U+1EEAB-1EEBB, U+1EEF0-1EEF1",
    },
  ],
  display: "swap",
  variable: "--font-tajawal-arabic",
  adjustFontFallback: false,
});

export const plexLatin = localFont({
  src: [
    { path: "./ibm-plex-sans-arabic-latin-400.woff2", weight: "400", style: "normal" },
    { path: "./ibm-plex-sans-arabic-latin-500.woff2", weight: "500", style: "normal" },
    { path: "./ibm-plex-sans-arabic-latin-600.woff2", weight: "600", style: "normal" },
  ],
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
  display: "swap",
  variable: "--font-plex-latin",
  adjustFontFallback: false,
});

export const plexLatinExt = localFont({
  src: [
    { path: "./ibm-plex-sans-arabic-latin-ext-400.woff2", weight: "400", style: "normal" },
    { path: "./ibm-plex-sans-arabic-latin-ext-500.woff2", weight: "500", style: "normal" },
    { path: "./ibm-plex-sans-arabic-latin-ext-600.woff2", weight: "600", style: "normal" },
  ],
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
  display: "swap",
  variable: "--font-plex-latin-ext",
  preload: false,
  adjustFontFallback: false,
});

export const plexArabic = localFont({
  src: [
    { path: "./ibm-plex-sans-arabic-arabic-400.woff2", weight: "400", style: "normal" },
    { path: "./ibm-plex-sans-arabic-arabic-500.woff2", weight: "500", style: "normal" },
    { path: "./ibm-plex-sans-arabic-arabic-600.woff2", weight: "600", style: "normal" },
  ],
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0897-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC, U+102E0-102FB, U+10E60-10E7E, U+10EC2-10EC4, U+10EFC-10EFF, U+1EE00-1EE03, U+1EE05-1EE1F, U+1EE21-1EE22, U+1EE24, U+1EE27, U+1EE29-1EE32, U+1EE34-1EE37, U+1EE39, U+1EE3B, U+1EE42, U+1EE47, U+1EE49, U+1EE4B, U+1EE4D-1EE4F, U+1EE51-1EE52, U+1EE54, U+1EE57, U+1EE59, U+1EE5B, U+1EE5D, U+1EE5F, U+1EE61-1EE62, U+1EE64, U+1EE67-1EE6A, U+1EE6C-1EE72, U+1EE74-1EE77, U+1EE79-1EE7C, U+1EE7E, U+1EE80-1EE89, U+1EE8B-1EE9B, U+1EEA1-1EEA3, U+1EEA5-1EEA9, U+1EEAB-1EEBB, U+1EEF0-1EEF1",
    },
  ],
  display: "swap",
  variable: "--font-plex-arabic",
  adjustFontFallback: false,
});
