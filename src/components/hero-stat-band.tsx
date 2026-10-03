import type { ReactNode } from "react";

export interface HeroStatItem {
  label: string;
  value: ReactNode;
}

/**
 * Classes of stat `i` of `count`. Below `sm` the stats sit in a 2-column grid
 * (a stacked column of three took ~260px of a phone screen; two columns take
 * about 120px), and from `sm` up in one row, as before:
 *
 *  - phone: the second item of each row gets a start-side hairline, every row
 *    after the first a top hairline, and an odd last item spans both columns
 *    (so the biggest number, the stored records, gets a full-width cell and
 *    cannot overflow a 150px one, whatever its digit count);
 *  - `sm` up: every item but the first has the start-side hairline and padding.
 *
 * A grid never wraps an item onto a row of its own, which is how the earlier
 * flex-wrap row left a dangling vertical hairline on a lone wrapped item.
 */
function itemClass(i: number, count: number): string {
  const classes = ["min-w-0", "border-line-dark"];
  if (i % 2 === 1) classes.push("border-s", "ps-4");
  if (i >= 2) classes.push("border-t", "pt-4", "sm:border-t-0", "sm:pt-0");
  if (i === count - 1 && count % 2 === 1) classes.push("col-span-2", "sm:col-span-1");
  if (i > 0) classes.push("sm:border-s", "sm:ps-8");
  return classes.join(" ");
}

/**
 * The signature "hero stat band" — stats separated by 1px hairlines, label
 * above in muted sand, value in the display font. Reused on the home hero
 * and can be reused anywhere else a dark band needs a stat row.
 *
 * `footer` is a full-width row under a hairline for what is not a number:
 * the home page puts the freshness line and the refresh button there.
 */
export function HeroStatBand({ items, footer }: { items: HeroStatItem[]; footer?: ReactNode }) {
  return (
    <div className="mt-6 border-t border-line-dark pt-5 sm:mt-10 sm:pt-8">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:flex sm:flex-row sm:flex-wrap sm:gap-x-8 sm:gap-y-6">
        {items.map((item, i) => (
          <div key={item.label} className={itemClass(i, items.length)}>
            <dt className="text-xs font-medium text-sand-100/75">{item.label}</dt>
            <dd className="mt-1 break-words font-display text-2xl font-bold sm:text-3xl">{item.value}</dd>
          </div>
        ))}
      </dl>
      {footer && (
        <div className="mt-5 flex flex-col gap-3 border-t border-line-dark pt-4 sm:mt-8 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:pt-6">
          {footer}
        </div>
      )}
    </div>
  );
}
