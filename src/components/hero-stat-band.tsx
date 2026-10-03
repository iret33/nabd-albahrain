import type { ReactNode } from "react";

export interface HeroStatItem {
  label: string;
  value: ReactNode;
}

/**
 * The signature "hero stat band" — stats separated by 1px hairlines, label
 * above in muted sand, value in the display font. Reused on the home hero
 * and can be reused anywhere else a dark band needs a stat row.
 *
 * Below `sm`, items stack in a single column with a horizontal divider
 * between them instead of a `flex-wrap` row — a plain "every item but the
 * first gets a `border-r`" rule (which is all this needs from `sm` up,
 * where all items fit on one row) leaves a dangling vertical hairline on
 * whichever item wraps onto its own new row at narrow widths, since that
 * item's right border no longer sits next to a right-hand neighbor.
 *
 * `footer` is a full-width row under a hairline for what is not a number:
 * the home page puts the freshness line and the refresh button there.
 */
export function HeroStatBand({ items, footer }: { items: HeroStatItem[]; footer?: ReactNode }) {
  return (
    <div className="mt-10 border-t border-line-dark pt-8">
      <dl className="flex flex-col gap-6 sm:flex-row sm:flex-wrap sm:gap-x-8 sm:gap-y-6">
        {items.map((item, i) => (
          <div
            key={item.label}
            className={
              i > 0
                ? "border-t border-line-dark pt-6 sm:border-t-0 sm:border-r sm:pt-0 sm:pr-8"
                : undefined
            }
          >
            <dt className="text-xs font-medium text-sand-100/75">{item.label}</dt>
            <dd className="mt-1 font-display text-3xl font-bold">{item.value}</dd>
          </div>
        ))}
      </dl>
      {footer && (
        <div className="mt-8 flex flex-col gap-4 border-t border-line-dark pt-6 sm:flex-row sm:items-center sm:justify-between">
          {footer}
        </div>
      )}
    </div>
  );
}
