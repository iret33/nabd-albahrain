import type { ColumnMeta } from "@/lib/cell-format";
import { completenessPercent, formatTemporalValue } from "@/lib/cell-format";
import { NumberLatin } from "@/components/number-latin";

/**
 * What the sync measured about one column (`statsJson`): completeness,
 * distinct values, range, mean/median, unit and, for low-cardinality text, the
 * most frequent values. A Server Component with no client JS.
 *
 * Every figure is optional: a field that is all null has no range, a text field
 * has no mean, and a row synced before stats existed has none of it. Missing
 * pieces are skipped; with no stats at all this renders nothing, so the
 * dictionary still reads fine for older rows.
 */

function RangeValue({ raw, column }: { raw: number | string; column: ColumnMeta }) {
  if (column.type === "date" || column.type === "datetime") {
    const cell = formatTemporalValue(raw, column.type);
    if (cell) return <bdi>{cell.text}</bdi>;
  }
  if (typeof raw === "number") return <NumberLatin value={raw} grouped={!column.plainDigits} maximumFractionDigits={6} />;
  return (
    <bdi dir="ltr" className="tabular-figures">
      {raw}
    </bdi>
  );
}

export function FieldProfile({ column }: { column: ColumnMeta }) {
  const stats = column.stats;
  if (!stats) return null;

  const complete = completenessPercent(stats.nullRate);
  const quantity = (column.type === "int" || column.type === "double") && !column.plainDigits;
  const hasRange = stats.min !== undefined && stats.max !== undefined;
  const distinct =
    stats.distinctCount === "1000+" ? (
      <>
        أكثر من <NumberLatin value={1000} />
      </>
    ) : (
      <NumberLatin value={stats.distinctCount} />
    );
  const topValues = column.type === "text" && Array.isArray(stats.topValues) ? stats.topValues : [];

  return (
    <div className="min-w-0">
      {complete !== null && (
        <div className="flex items-center gap-2 text-xs text-ink/70">
          <span aria-hidden="true" className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-line-light">
            <span className="block h-full rounded-full bg-sea-800" style={{ width: `${complete}%` }} />
          </span>
          <span>
            <NumberLatin value={complete} maximumFractionDigits={1} />% مكتمل
          </span>
        </div>
      )}

      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-ink/80 min-[420px]:grid-cols-2">
        <div className="flex gap-1.5">
          <dt className="text-ink/70">قيم مميزة:</dt>
          <dd className="font-medium">{distinct}</dd>
        </div>
        {hasRange && (
          <div className="flex flex-wrap gap-1.5">
            <dt className="text-ink/70">المدى:</dt>
            <dd className="font-medium">
              من <RangeValue raw={stats.min as number | string} column={column} /> إلى{" "}
              <RangeValue raw={stats.max as number | string} column={column} />
            </dd>
          </div>
        )}
        {quantity && typeof stats.mean === "number" && (
          <div className="flex gap-1.5">
            <dt className="text-ink/70">المتوسط:</dt>
            <dd className="font-medium">
              <NumberLatin value={stats.mean} maximumFractionDigits={2} />
            </dd>
          </div>
        )}
        {quantity && typeof stats.median === "number" && (
          <div className="flex gap-1.5">
            <dt className="text-ink/70">الوسيط:</dt>
            <dd className="font-medium">
              <NumberLatin value={stats.median} maximumFractionDigits={2} />
            </dd>
          </div>
        )}
        {stats.unit && (
          <div className="flex gap-1.5">
            <dt className="text-ink/70">الوحدة:</dt>
            <dd className="font-medium">
              <bdi>{stats.unit}</bdi>
            </dd>
          </div>
        )}
      </dl>

      {topValues.length > 0 && (
        <div className="mt-2">
          <p className="text-xs text-ink/70">أكثر القيم تكرارًا:</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {topValues.map((tv) => (
              <li key={tv.value} className="max-w-full rounded-full bg-sand-100 px-2.5 py-1 text-xs text-ink">
                <bdi className="break-words">{tv.value}</bdi>{" "}
                <span className="text-ink/70">
                  (<NumberLatin value={tv.count} />)
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
