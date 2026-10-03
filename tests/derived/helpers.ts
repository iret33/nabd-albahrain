import { computeDerivedFields, type DerivedFields, type VizConfig } from "@/lib/sync/derived";
import type { VizOverride } from "@/config/viz-overrides";
import type { CatalogField } from "@/lib/sync/schemas";

export type Rec = Record<string, unknown>;

/** A catalog field the way the ODS API describes it. */
export function field(name: string, type: string, label?: string, annotations?: Record<string, unknown>): CatalogField {
  return { name, type, label: label ?? name, ...(annotations ? { annotations } : {}) } as CatalogField;
}

/** computeDerivedFields without any config override unless one is passed (tests must not depend on src/config). */
export async function derive(
  records: Rec[],
  fields: CatalogField[],
  override: VizOverride | null = null,
): Promise<DerivedFields & { viz: VizConfig; rows: Array<Record<string, unknown>> }> {
  const out = await computeDerivedFields("test-dataset", records, fields, { override });
  return { ...out, viz: out.vizConfig as VizConfig, rows: (out.chartData ?? []) as Array<Record<string, unknown>> };
}

/** "2024-01" .. "2025-12" style month list. */
export function months(fromYear: number, toYear: number): string[] {
  const out: string[] = [];
  for (let y = fromYear; y <= toYear; y++) for (let m = 1; m <= 12; m++) out.push(`${y}-${String(m).padStart(2, "0")}`);
  return out;
}

export function years(from: number, to: number): number[] {
  const out: number[] = [];
  for (let y = from; y <= to; y++) out.push(y);
  return out;
}
