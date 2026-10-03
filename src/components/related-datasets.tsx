import { getRelatedDatasets } from "@/lib/queries";
import { DatasetCard } from "@/components/dataset-card";

/**
 * "مجموعات ذات صلة": up to six live datasets that share the theme and/or the
 * publisher, same-theme-and-publisher first (see `getRelatedDatasets`). Rendered
 * below the records table so the only way out of a dataset is no longer the
 * breadcrumb. Renders nothing when there are none.
 *
 * Awaited in place by the dataset page (no <Suspense>, so a browser without
 * JavaScript sees it), hence the try/catch: a failed read must cost this strip,
 * not turn the whole page into the error boundary (same as the footer's line).
 */
export async function RelatedDatasets({
  id,
  theme,
  publisher,
}: {
  id: string;
  theme: string | null;
  publisher: string | null;
}) {
  let items: Awaited<ReturnType<typeof getRelatedDatasets>>;
  try {
    items = await getRelatedDatasets(id, theme, publisher, 6);
  } catch (err) {
    console.error(`[related-datasets] unavailable for ${id}:`, err);
    return null;
  }
  if (items.length === 0) return null;

  return (
    <section aria-labelledby="related-heading" className="mt-14 border-t border-line-light pt-10">
      <h2 id="related-heading" className="font-display text-xl font-bold text-sea-900">
        مجموعات ذات صلة
      </h2>
      <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((dataset) => (
          <DatasetCard key={dataset.id} dataset={dataset} headingLevel={3} />
        ))}
      </div>
    </section>
  );
}
