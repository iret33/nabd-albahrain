/**
 * The streamed body of `GET /api/v1/datasets/{id}/records?format=csv`. Pure (the
 * batches come in through callbacks), so every end of the stream is unit-tested
 * without a database.
 *
 * Pull-based: each `pull` loads one batch, so a slow client never makes the server
 * buffer the dataset and memory stays flat however large it is.
 *
 * An export ends in exactly one of four ways, and the slot it holds (`onEnd`) is
 * given back exactly once in all of them:
 *  - complete: the last batch had no `nextAfter` -> clean close;
 *  - failed: a batch threw (a database error, a STALE CURSOR because a sync replaced
 *    the dataset mid-download) -> `controller.error`, so the client sees a failed
 *    download. Headers are long gone, so a clean close would be a truncated file that
 *    looks complete;
 *  - cap: `maxRows` rows were sent and there is still more -> the same error, never a
 *    quiet end of file (the cap is a runaway guard that no real dataset reaches);
 *  - cancelled / too slow: the client went away (Next calls `cancel`), stopped
 *    reading for `idleMs`, or has been downloading longer than `maxMs` -> the stream
 *    is dropped. Without these, an aborted download would leak its slot until the
 *    server refuses every export, and two clients reading one byte a minute could
 *    hold every slot forever.
 */

import { CSV_BOM, CSV_MAX_ROWS, csvRow } from "@/lib/api-v1";

export interface CsvBatch {
  rows: ReadonlyArray<{ id: string; data: Record<string, unknown> }>;
  /** Cursor of the batch after this one; null when this was the last. */
  nextAfter: string | null;
}

export interface CsvStreamOptions {
  /** Column names, in order. Empty = use the first row's keys (a dataset with no field dictionary). */
  columns: readonly string[];
  /**
   * The first batch, ALREADY READ by the caller. Reading it before the response is built is what lets an
   * unknown dataset, a stale `after` or a database error become a proper HTTP error instead of a 200
   * whose body then fails.
   */
  first: CsvBatch;
  /** The batch after cursor `after` (the previous batch's `nextAfter`). May throw; a thrown error fails the stream. */
  next(after: string): Promise<CsvBatch | null>;
  /** Stop with an error after this many rows if there is still more. Default `CSV_MAX_ROWS`. */
  maxRows?: number;
  /** Fail when the previous chunk has not been read for this long (default 30 s). */
  idleMs?: number;
  /** Fail when the download has lasted this long in total (default 10 min). */
  maxMs?: number;
  /** Called exactly once, however the stream ends. Give the export slot back here. */
  onEnd?: () => void;
  /** Called with the reason when the stream is ABORTED (failure, cap, too slow), not on a normal end or a client cancel. */
  onAbort?: (err: unknown) => void;
}

export const CSV_IDLE_MS = 30_000;
export const CSV_MAX_MS = 600_000;

export class CsvAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvAbortError";
  }
}

export function createCsvStream(options: CsvStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const maxRows = options.maxRows ?? CSV_MAX_ROWS;
  const idleMs = options.idleMs ?? CSV_IDLE_MS;
  const maxMs = options.maxMs ?? CSV_MAX_MS;

  let columns = [...options.columns];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let batch: CsvBatch | null = null; // the batch to send on the next pull (the first one, then each fetched)
  let started = false;
  let sent = 0;
  let after: string | null = null;
  let ended = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let lifeTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (lifeTimer) clearTimeout(lifeTimer);
    idleTimer = lifeTimer = null;
  };

  /** Mark the end, free the slot (once). Returns false when the stream had already ended. */
  const end = (): boolean => {
    if (ended) return false;
    ended = true;
    clearTimers();
    options.onEnd?.();
    return true;
  };

  const abort = (err: unknown) => {
    if (!end()) return;
    options.onAbort?.(err);
    // A no-op when the stream is already closed or cancelled (the Streams spec), so it needs no guard.
    controller?.error(err);
  };

  const arm = (ms: number, why: string) => {
    const timer = setTimeout(() => abort(new CsvAbortError(why)), ms);
    timer.unref?.();
    return timer;
  };

  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      batch = options.first;
      lifeTimer = arm(maxMs, `csv export exceeded ${maxMs} ms`);
    },

    async pull(c) {
      if (ended) return;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      try {
        if (started) {
          const next: CsvBatch | null = after === null ? null : await options.next(after);
          if (ended) return; // cancelled or timed out while the batch was loading
          if (next === null) throw new CsvAbortError("dataset disappeared during the export");
          batch = next;
        }
        const current = batch as CsvBatch;

        let chunk = "";
        if (!started) {
          // A dataset with no field dictionary still gets sensible columns: the first row's keys.
          if (columns.length === 0 && current.rows.length > 0) columns = Object.keys(current.rows[0].data);
          chunk += CSV_BOM + csvRow(columns);
          started = true;
        }
        for (const row of current.rows) chunk += csvRow(columns.map((col) => row.data[col]));
        c.enqueue(encoder.encode(chunk));

        sent += current.rows.length;
        after = current.nextAfter;
        if (after === null || current.rows.length === 0) {
          if (end()) c.close();
        } else if (sent >= maxRows) {
          throw new CsvAbortError(`csv row cap reached (${maxRows}) with more rows remaining`);
        } else {
          idleTimer = arm(idleMs, `csv client read nothing for ${idleMs} ms`);
        }
      } catch (err) {
        abort(err);
      }
    },

    cancel() {
      // The client disconnected: nothing to tell it, but the slot must come back.
      end();
    },
  });
}
