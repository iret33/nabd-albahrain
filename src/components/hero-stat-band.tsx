import type { ReactNode } from "react";

export interface HeroStatItem {
  label: string;
  value: ReactNode;
}

/**
 * The signature "hero stat band" — stats separated by 1px hairlines, label
 * above in muted sand, value in the display font. Reused on the home hero
 * and can be reused anywhere else a dark band needs a stat row.
 */
export function HeroStatBand({ items }: { items: HeroStatItem[] }) {
  return (
    <dl className="mt-10 flex flex-wrap gap-x-8 gap-y-6 border-t border-line-dark pt-8">
      {items.map((item, i) => (
        <div key={item.label} className={i > 0 ? "border-r border-line-dark pr-8" : undefined}>
          <dt className="text-xs font-medium text-sand-100/60">{item.label}</dt>
          <dd className="mt-1 font-display text-3xl font-bold">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
