/**
 * Browser-only: renders the live Recharts SVG into a PNG with a title block,
 * legend and attribution, ready to share. Client modules only (touches
 * `document`, `Image` and `canvas`).
 *
 * How it works: the SVG is cloned and serialized with `XMLSerializer`, its
 * `var(--token)` references are replaced by the page's computed values (an SVG
 * drawn as an <img> cannot see custom properties), and it is loaded as a
 * `data:` image (allowed by the CSP, and not a tainting source for canvas).
 * The headline text and legend are drawn on the canvas around it, right to
 * left, in the page's own (already loaded) font, which the SVG itself cannot
 * use. Rendered at 2x for sharpness.
 */

import { EXPORT_FONT_FAMILY, inlineCssVars, wrapWords } from "@/lib/svg-export";

export interface PngLegendItem {
  label: string;
  color: string;
  dash?: string;
}

export interface PngExportOptions {
  svg: SVGSVGElement;
  /** The chart's caption title: what is plotted. */
  title: string;
  /** Qualifiers worth printing (aggregated dimensions, partial period, ...). */
  notes: string[];
  legend: PngLegendItem[];
  footer: string;
  scale?: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const PAD = 24;
const WHITE = "#ffffff";
const INK = "#17262A";
const MUTED = "#4b5a5e";

function readRootVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("svg image failed to load"));
    img.src = src;
  });
}

/** The SVG as a standalone, self-contained data URL. */
export function svgToDataUrl(svg: SVGSVGElement): { url: string; width: number; height: number } {
  const rect = svg.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));

  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  clone.removeAttribute("tabindex");
  clone.removeAttribute("role");
  clone.setAttribute("style", `font-family: ${EXPORT_FONT_FAMILY}; background: ${WHITE};`);

  const markup = inlineCssVars(new XMLSerializer().serializeToString(clone), readRootVar);
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`, width, height };
}

function drawLegendSwatch(ctx: CanvasRenderingContext2D, item: PngLegendItem, xRight: number, y: number): number {
  const w = 22;
  ctx.save();
  ctx.strokeStyle = item.color;
  ctx.fillStyle = item.color;
  ctx.lineWidth = 3;
  if (item.dash) ctx.setLineDash(item.dash.split(/\s+/).map((n) => Number(n) || 3));
  ctx.beginPath();
  ctx.moveTo(xRight - w, y);
  ctx.lineTo(xRight, y);
  ctx.stroke();
  ctx.restore();
  return w;
}

export async function renderChartPng(options: PngExportOptions): Promise<Blob> {
  const { svg, title, notes, legend, footer } = options;
  const scale = options.scale ?? 2;
  if (typeof document.fonts?.ready?.then === "function") await document.fonts.ready;

  const { url, width, height } = svgToDataUrl(svg);
  const image = await loadImage(url);

  const family = getComputedStyle(document.body).fontFamily || EXPORT_FONT_FAMILY;
  const outerWidth = Math.max(width + PAD * 2, 480);
  const textWidth = outerWidth - PAD * 2;

  // Measure on a scratch context first so the canvas can be sized to the text block.
  const scratch = document.createElement("canvas").getContext("2d");
  if (!scratch) throw new Error("canvas is not available");
  const font = (px: number, weight = 400) => `${weight} ${px}px ${family}`;
  scratch.font = font(18, 700);
  const titleLines = wrapWords(title, textWidth, (s) => scratch.measureText(s).width, 3);
  scratch.font = font(13);
  const noteLines = notes.flatMap((n) => wrapWords(n, textWidth, (s) => scratch.measureText(s).width, 2)).slice(0, 5);

  const legendRows: PngLegendItem[][] = [];
  if (legend.length > 1) {
    scratch.font = font(13);
    let row: PngLegendItem[] = [];
    let rowWidth = 0;
    for (const item of legend) {
      const itemWidth = 22 + 8 + scratch.measureText(item.label).width + 22;
      if (row.length > 0 && rowWidth + itemWidth > textWidth) {
        legendRows.push(row);
        row = [];
        rowWidth = 0;
      }
      row.push(item);
      rowWidth += itemWidth;
    }
    if (row.length > 0) legendRows.push(row);
  }

  const titleBlock = titleLines.length * 26;
  const notesBlock = noteLines.length * 20 + (noteLines.length > 0 ? 6 : 0);
  const legendBlock = legendRows.length * 24 + (legendRows.length > 0 ? 8 : 0);
  const headerHeight = PAD + titleBlock + notesBlock + legendBlock + 8;
  const footerHeight = 34;
  const outerHeight = headerHeight + height + footerHeight;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(outerWidth * scale);
  canvas.height = Math.round(outerHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas is not available");
  ctx.scale(scale, scale);
  ctx.fillStyle = WHITE;
  ctx.fillRect(0, 0, outerWidth, outerHeight);

  ctx.direction = "rtl";
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  const right = outerWidth - PAD;
  let y = PAD + 18;

  ctx.fillStyle = INK;
  ctx.font = font(18, 700);
  for (const line of titleLines) {
    ctx.fillText(line, right, y);
    y += 26;
  }
  y -= 6;

  ctx.fillStyle = MUTED;
  ctx.font = font(13);
  for (const line of noteLines) {
    y += 20;
    ctx.fillText(line, right, y);
  }
  if (noteLines.length > 0) y += 6;

  for (const row of legendRows) {
    y += 24;
    let x = right;
    for (const item of row) {
      const swatch = drawLegendSwatch(ctx, item, x, y - 4);
      x -= swatch + 8;
      ctx.fillStyle = INK;
      ctx.font = font(13);
      ctx.fillText(item.label, x, y);
      x -= ctx.measureText(item.label).width + 22;
    }
  }

  // The chart itself, centered when the canvas is wider than the SVG.
  ctx.drawImage(image, (outerWidth - width) / 2, headerHeight, width, height);

  ctx.fillStyle = MUTED;
  ctx.font = font(12);
  ctx.fillText(footer, right, outerHeight - 12);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("png encoding failed"))), "image/png");
  });
}
