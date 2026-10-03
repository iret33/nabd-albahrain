"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { VizConfig } from "@/lib/sync/derived";
import { chartTableModel, buildCsv, downloadFilename } from "@/lib/chart-table";
import type { SeriesSpec } from "@/lib/chart-model";
import { renderChartPng } from "@/components/charts/chart-png";

/**
 * "تنزيل CSV" and "تنزيل PNG" for the plotted series, built entirely in the
 * browser from data the page already holds (no request, so it works while the
 * official portal is down). Downloads go through a `blob:` URL (allowed by the
 * CSP). The CSV is UTF-8 with a BOM and Excel-safe cells (see `chart-table.ts`);
 * the PNG is the live SVG plus a title block and legend (see `chart-png.ts`).
 *
 * Results are announced in an always-mounted polite live region.
 */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const buttonClass =
  "inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-light bg-white px-4 py-2 text-sm font-medium text-ink/80 shadow-sm transition-colors hover:border-coral hover:text-coral disabled:cursor-wait disabled:opacity-70";

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" />
    </svg>
  );
}

export function ChartToolbar({
  datasetId,
  vizConfig,
  chartData,
  title,
  notes,
  specs,
  canvasRef,
}: {
  datasetId: string;
  vizConfig: VizConfig;
  chartData: readonly unknown[];
  /** The caption title (what is plotted); used for the PNG header. */
  title: string;
  notes: string[];
  /** The series currently shown (the PNG legend lists exactly what the picture draws). */
  specs: readonly SeriesSpec[];
  /** The element that contains the rendered chart SVG. */
  canvasRef: RefObject<HTMLElement | null>;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function announce(text: string) {
    setMessage(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(""), 5000);
  }

  function downloadCsv() {
    const table = chartTableModel(vizConfig, chartData);
    if (!table) return announce("لا توجد بيانات رسم لتنزيلها");
    saveBlob(new Blob([buildCsv(table)], { type: "text/csv;charset=utf-8" }), downloadFilename(datasetId, "chart", "csv"));
    announce("تم تنزيل ملف CSV");
  }

  async function downloadPng() {
    const svg = canvasRef.current?.querySelector<SVGSVGElement>("svg.recharts-surface");
    if (!svg) return announce("الرسم لم يكتمل تحميله بعد، حاول بعد لحظات");
    setBusy(true);
    try {
      const blob = await renderChartPng({
        svg,
        title,
        notes,
        legend: specs.map((s) => ({ label: s.label, color: s.color, dash: s.dash })),
        footer: "نبض البحرين — البيانات من data.gov.bh",
      });
      saveBlob(blob, downloadFilename(datasetId, "chart", "png"));
      announce("تم تنزيل صورة الرسم");
    } catch {
      announce("تعذّر إنشاء الصورة في هذا المتصفح");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={downloadCsv} className={buttonClass} title="بيانات الرسم كاملة (كل السلاسل) كملف CSV يفتح في إكسل">
        <DownloadIcon />
        تنزيل CSV
      </button>
      <button type="button" onClick={downloadPng} disabled={busy} aria-busy={busy} className={buttonClass} title="الرسم كصورة PNG">
        <DownloadIcon />
        تنزيل PNG
      </button>
      <span role="status" aria-live="polite" className={message ? "text-xs font-medium text-ink/80" : "sr-only"}>
        {message}
      </span>
    </div>
  );
}
