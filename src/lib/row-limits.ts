/**
 * Row limits shared by the sync engine (what it stores) and everything that
 * reads the stored rows back (the CSV export, the records pager). Pure and
 * import-free, so the engine, the API and the unit tests can all use it
 * without dragging Prisma in.
 *
 * Why one module: the engine and the CSV export used to carry their own copies
 * of these numbers (300,000 stored vs a 200,000 export stop), and a dataset
 * between the two was stored complete but exported cut short with nothing
 * saying so. `tests/queries/row-limits.test.ts` also checks that the engine
 * still agrees with this file.
 */

/** Rows inserted per `createMany` while replacing a dataset. */
export const INSERT_BATCH_SIZE = 1000;

/** A dataset with more rows than this is stored PARTIALLY (its first rows only) and marked `partial`. */
export const MAX_ROWS_HARD_CAP = 300_000;

/** How many rows of an over-cap dataset are kept. */
export const MAX_ROWS_STORED_WHEN_CAPPED = 50_000;
