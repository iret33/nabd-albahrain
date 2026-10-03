import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
/** The source without comments (the docs name the very things the code must no longer contain). */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Every file under `dir` (relative to the repo root), recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

describe("R5-01: pages must not depend on streaming (it needs JavaScript to reveal)", () => {
  it("the home route has no loading.tsx: a browser without JavaScript kept its skeleton for good", () => {
    expect(existsSync(path.join(root, "src/app/(home)/loading.tsx"))).toBe(false);
  });

  it("the dataset route has no loading.tsx either (it would also commit a 200 before notFound())", () => {
    expect(existsSync(path.join(root, "src/app/dataset/[id]/loading.tsx"))).toBe(false);
  });

  it("the dataset page awaits its records table and related datasets in place, with no <Suspense>", () => {
    const source = code("src/app/dataset/[id]/page.tsx");
    expect(source).not.toMatch(/<Suspense/);
    expect(source).not.toMatch(/from "react"/);
    expect(source).toMatch(/<RecordsSection/);
    expect(source).toMatch(/<RelatedDatasets/);
    // notFound() is decided before either of them renders, so a missing dataset keeps its 404
    expect(source.indexOf("notFound()")).toBeLessThan(source.indexOf("<RecordsSection"));
  });

  it("a failed related-datasets or records read costs its own section, not the whole page", () => {
    expect(read("src/components/related-datasets.tsx")).toMatch(/catch \(err\)[\s\S]*console\.error[\s\S]*return null/);
    expect(read("src/app/dataset/[id]/page.tsx")).toMatch(/catch \(err\)[\s\S]*console\.error\(`\[dataset page\] records unavailable/);
  });

  it("the chart canvas says in words, without JavaScript, where its numbers are", () => {
    expect(read("src/components/charts/chart-loader.tsx")).toMatch(/<noscript>[\s\S]*يتطلب الرسم البياني تفعيل JavaScript[\s\S]*<\/noscript>/);
  });
});

describe("R6-07: fonts are self-hosted, so a build needs no font host", () => {
  const fontDir = "src/app/fonts";

  it("nothing imports next/font/google", () => {
    const offenders = walk("src").filter((f) => /\.(ts|tsx)$/.test(f) && /next\/font\/google/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it("ships the woff2 subsets for every weight, with the OFL texts beside them", () => {
    const files = readdirSync(path.join(root, fontDir)).sort();
    for (const w of ["700", "900"]) for (const s of ["arabic", "latin"]) expect(files).toContain(`tajawal-${s}-${w}.woff2`);
    for (const w of ["400", "500", "600"]) for (const s of ["arabic", "latin", "latin-ext"]) expect(files).toContain(`ibm-plex-sans-arabic-${s}-${w}.woff2`);
    expect(files).toContain("OFL-Tajawal.txt");
    expect(files).toContain("OFL-IBM-Plex-Sans-Arabic.txt");
    for (const license of ["OFL-Tajawal.txt", "OFL-IBM-Plex-Sans-Arabic.txt"]) {
      expect(read(`${fontDir}/${license}`)).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/i);
    }
    // real woff2 files (magic "wOF2"), not an HTML error page saved by a failed download
    for (const f of files.filter((n) => n.endsWith(".woff2"))) {
      expect(readFileSync(path.join(root, fontDir, f)).subarray(0, 4).toString("latin1"), f).toBe("wOF2");
    }
  });

  it("every localFont() face points at a file that exists and carries its own unicode-range", () => {
    const source = read(`${fontDir}/fonts.ts`);
    const paths = [...source.matchAll(/path: "\.\/([^"]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBe(13);
    for (const p of paths) expect(existsSync(path.join(root, fontDir, p)), p).toBe(true);
    const calls = source.split("localFont({").length - 1;
    expect(calls).toBe(5);
    expect(source.match(/prop: "unicode-range"/g)).toHaveLength(calls);
    // faces of one family and weight without a unicode-range would shadow each other (Arabic would fall to Arial)
  });

  it("keeps the CSS variables the stylesheet and the font utilities use, and ends each stack with its fallback face", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/--font-display: var\(--font-tajawal\)/);
    expect(css).toMatch(/--font-sans: var\(--font-ibm-plex-sans-arabic\)/);
    expect(css).toMatch(/--font-tajawal: var\(--font-tajawal-latin\), var\(--font-tajawal-arabic\), "Tajawal Fallback"/);
    expect(css).toMatch(/--font-ibm-plex-sans-arabic: [^;]*var\(--font-plex-arabic\),\s*"IBM Plex Sans Arabic Fallback"/);
    expect(css).toMatch(/@font-face \{\s*font-family: "Tajawal Fallback";[^}]*size-adjust: 94\.66%/);
    // the layout puts every family's variable on <html>
    const layout = read("src/app/layout.tsx");
    for (const family of ["tajawalLatin", "tajawalArabic", "plexLatin", "plexLatinExt", "plexArabic"]) expect(layout).toContain(`${family}.variable`);
  });

  it("the weights are the ones the site used (Tajawal 700/900, Plex 400/500/600)", () => {
    const source = read(`${fontDir}/fonts.ts`);
    expect(new Set([...source.matchAll(/tajawal-[a-z-]+-(\d+)\.woff2/g)].map((m) => m[1]))).toEqual(new Set(["700", "900"]));
    expect(new Set([...source.matchAll(/ibm-plex-sans-arabic-[a-z-]+-(\d+)\.woff2/g)].map((m) => m[1]))).toEqual(new Set(["400", "500", "600"]));
  });
});

describe("R5-12: print stylesheet", () => {
  const css = read("src/app/globals.css");
  const printBlock = css.slice(css.indexOf("@media print"));

  it("has symmetric page margins and a print block outside any @layer", () => {
    expect(css).toMatch(/@page \{[^}]*margin: 14mm/);
    expect(css.indexOf("@media print")).toBeGreaterThan(css.indexOf("@layer base"));
    // unlayered: the block is not inside the `@layer base { ... }` that closes before it
    const beforePrint = css.slice(0, css.indexOf("@media print"));
    const opens = (beforePrint.match(/@layer base \{/g) ?? []).length;
    expect(opens).toBe(1);
    expect(beforePrint.lastIndexOf("@layer base {")).toBeLessThan(beforePrint.lastIndexOf(".scroll-cue-track"));
  });

  it("does not use local-attachment scroll shadows (Chromium mispositions them in RTL scrollers)", () => {
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/background-attachment:\s*local/);
    expect(css).toMatch(/@supports \(animation-timeline: scroll\(\)\)/);
    expect(css).toMatch(/scroll-timeline: --scroll-cue inline/);
    expect(printBlock).toMatch(/\.scroll-cue::before/);
  });

  it("keeps chart colors and theme chips, repairs the dark bands, and does not print search boxes", () => {
    expect(printBlock).toMatch(/print-color-adjust: exact/);
    expect(printBlock).toMatch(/\.surface-dark \*/);
    expect(printBlock).toMatch(/form\[role="search"\]/);
  });

  it("does not hide every button (the chart's series toggles are its only legend)", () => {
    expect(printBlock).not.toMatch(/(^|[\s,{])button\s*[,{]/m);
  });

  it("drops the controls on the dataset page but keeps its provenance", () => {
    const page = read("src/app/dataset/[id]/page.tsx");
    expect(page).toMatch(/print:hidden/);
    expect(page).toMatch(/hidden[^"]*print:block/); // the print-only URL and dates line
    expect(read("src/components/site-header.tsx")).toMatch(/<header className="[^"]*print:hidden/);
    expect(read("src/components/pagination.tsx")).toMatch(/<nav aria-label="ترقيم الصفحات" className="[^"]*print:hidden/);
    expect(read("src/components/charts/chart-toolbar.tsx")).toMatch(/print:hidden/);
    expect(read("src/components/copy-link-button.tsx")).toMatch(/print:hidden/);
    // the attribution line stays on paper; only the link list and the freshness line go
    const footer = read("src/components/site-footer.tsx");
    expect(footer).toMatch(/<nav aria-label="روابط إضافية" className="print:hidden"/);
    expect(footer).not.toMatch(/<footer[^>]*print:hidden/);
  });

  it("lets the records table print in full width instead of a clipped scroll box", () => {
    const table = read("src/components/records-table.tsx");
    expect(table).toMatch(/print:max-h-none print:overflow-visible/);
    expect(table).toMatch(/print:min-w-0/);
  });
});
