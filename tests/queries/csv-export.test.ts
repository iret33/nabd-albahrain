import { afterEach, describe, expect, it, vi } from "vitest";
import { CsvAbortError, createCsvStream, type CsvBatch } from "@/lib/csv-export";
import { StaleCursorError } from "@/lib/records-query";
import { CSV_BOM } from "@/lib/api-v1";

const row = (n: number) => ({ id: String(n), data: { n, name: `row ${n}` } as Record<string, unknown> });
const batchOf = (from: number, to: number, nextAfter: string | null): CsvBatch => ({
  rows: Array.from({ length: to - from + 1 }, (_, i) => row(from + i)),
  nextAfter,
});

/** Read a stream to its end; resolves with the text, or rejects with the stream's error. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  // ignoreBOM: keep the leading U+FEFF in the text (the default decoder would swallow it, hiding it from the assertions).
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

/** Pages 1..pages, `size` rows each, ids 1..; page k's nextAfter is its last id. */
function pagedSource(pages: number, size: number) {
  const calls: string[] = [];
  const first = batchOf(1, size, pages > 1 ? String(size) : null);
  const next = async (after: string): Promise<CsvBatch | null> => {
    calls.push(after);
    const page = Number(after) / size + 1;
    if (page > pages) return null;
    const from = (page - 1) * size + 1;
    return batchOf(from, from + size - 1, page < pages ? String(page * size) : null);
  };
  return { first, next, calls };
}

afterEach(() => vi.useRealTimers());

describe("createCsvStream: a complete export", () => {
  it("writes BOM + header + every row of every batch, then closes and frees the slot once", async () => {
    const src = pagedSource(3, 2);
    const onEnd = vi.fn();
    const onAbort = vi.fn();
    const text = await readAll(createCsvStream({ columns: ["n", "name"], first: src.first, next: src.next, onEnd, onAbort }));
    expect(text.startsWith(CSV_BOM)).toBe(true);
    const lines = text.slice(1).split("\r\n");
    expect(lines).toEqual(["n,name", "1,row 1", "2,row 2", "3,row 3", "4,row 4", "5,row 5", "6,row 6", ""]);
    expect(src.calls).toEqual(["2", "4"]);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("an empty dataset is just the header", async () => {
    const onEnd = vi.fn();
    const text = await readAll(
      createCsvStream({ columns: ["n"], first: { rows: [], nextAfter: null }, next: async () => null, onEnd }),
    );
    expect(text).toBe(`${CSV_BOM}n\r\n`);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("uses the first row's keys when the dataset has no field dictionary", async () => {
    const text = await readAll(
      createCsvStream({ columns: [], first: batchOf(1, 1, null), next: async () => null }),
    );
    expect(text).toBe(`${CSV_BOM}n,name\r\n1,row 1\r\n`);
  });

  it("a dataset of exactly maxRows rows is complete, not 'capped'", async () => {
    const src = pagedSource(2, 2);
    const onAbort = vi.fn();
    const text = await readAll(createCsvStream({ columns: ["n"], first: src.first, next: src.next, maxRows: 4, onAbort }));
    expect(text.slice(1).split("\r\n").filter(Boolean)).toHaveLength(5); // header + 4 rows
    expect(onAbort).not.toHaveBeenCalled();
  });
});

describe("createCsvStream: it never ends quietly short", () => {
  it("errors (and says why) when the row cap is reached with rows remaining, instead of closing cleanly", async () => {
    const src = pagedSource(10, 2);
    const onEnd = vi.fn();
    const onAbort = vi.fn();
    await expect(
      readAll(createCsvStream({ columns: ["n"], first: src.first, next: src.next, maxRows: 6, onEnd, onAbort })),
    ).rejects.toThrow(/row cap/);
    expect(src.calls).toEqual(["2", "4"]); // it stopped at the cap, it did not read on
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(onAbort.mock.calls[0][0]).toBeInstanceOf(CsvAbortError);
  });

  it("errors when a later batch hits a stale cursor (the dataset was replaced mid-download)", async () => {
    const first = batchOf(1, 2, "2");
    const next = vi.fn(async () => {
      throw new StaleCursorError();
    });
    const onEnd = vi.fn();
    const onAbort = vi.fn();
    await expect(readAll(createCsvStream({ columns: ["n"], first, next, onEnd, onAbort }))).rejects.toBeInstanceOf(StaleCursorError);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onAbort.mock.calls[0][0]).toBeInstanceOf(StaleCursorError);
  });

  it("errors when the dataset vanishes between batches", async () => {
    const onEnd = vi.fn();
    await expect(
      readAll(createCsvStream({ columns: ["n"], first: batchOf(1, 2, "2"), next: async () => null, onEnd })),
    ).rejects.toThrow(/disappeared/);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("errors on a database failure mid-export", async () => {
    const onEnd = vi.fn();
    await expect(
      readAll(
        createCsvStream({
          columns: ["n"],
          first: batchOf(1, 2, "2"),
          next: async () => {
            throw new Error("connection lost");
          },
          onEnd,
        }),
      ),
    ).rejects.toThrow("connection lost");
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe("createCsvStream: the slot always comes back", () => {
  it("frees it when the client cancels (disconnects) mid-download, and stops reading", async () => {
    const src = pagedSource(10, 2);
    const onEnd = vi.fn();
    const onAbort = vi.fn();
    const stream = createCsvStream({ columns: ["n"], first: src.first, next: src.next, onEnd, onAbort });
    const reader = stream.getReader();
    await reader.read(); // BOM + header + first batch
    await reader.cancel("client went away");
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onAbort).not.toHaveBeenCalled(); // a disconnect is not a server failure
    const callsAtCancel = src.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(src.calls.length).toBe(callsAtCancel);
  });

  it("frees it when the client cancels while a batch is still loading, without enqueueing afterwards", async () => {
    let resolveBatch!: (b: CsvBatch) => void;
    const next = vi.fn(() => new Promise<CsvBatch | null>((resolve) => (resolveBatch = resolve)));
    const onEnd = vi.fn();
    const stream = createCsvStream({ columns: ["n"], first: batchOf(1, 2, "2"), next, onEnd });
    const reader = stream.getReader();
    await reader.read();
    // The reader asks for more; the stream starts loading batch 2 ...
    const pending = reader.read();
    await vi.waitFor(() => expect(next).toHaveBeenCalled());
    await reader.cancel();
    expect(onEnd).toHaveBeenCalledTimes(1);
    resolveBatch(batchOf(3, 4, null)); // ... which finishes after the cancel: must be dropped, not thrown
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("calls onEnd exactly once even when an abort and a cancel race", async () => {
    const onEnd = vi.fn();
    const stream = createCsvStream({
      columns: ["n"],
      first: batchOf(1, 2, "2"),
      next: async () => {
        throw new Error("boom");
      },
      onEnd,
    });
    const reader = stream.getReader();
    await reader.read();
    await reader.read().catch(() => undefined);
    await reader.cancel().catch(() => undefined);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("a reader that keeps up is never 'idle': each read asks for the next batch at once", async () => {
    vi.useFakeTimers();
    const src = pagedSource(4, 2);
    const onAbort = vi.fn();
    const stream = createCsvStream({ columns: ["n"], first: src.first, next: src.next, idleMs: 1000, maxMs: 60_000, onAbort });
    const reader = stream.getReader();
    let text = "";
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
      await vi.advanceTimersByTimeAsync(900); // slower than nothing, faster than idleMs
    }
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(1 + 8);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("an unread stream is dropped after idleMs (a slow-loris client, or a consumer stuck on a full socket)", async () => {
    vi.useFakeTimers();
    const src = pagedSource(5, 2);
    const onEnd = vi.fn();
    const onAbort = vi.fn();
    // highWaterMark 1: the first chunk is enqueued and the stream then waits for a read that never comes.
    const stream = createCsvStream({ columns: ["n"], first: src.first, next: src.next, idleMs: 1000, maxMs: 60_000, onEnd, onAbort });
    await vi.advanceTimersByTimeAsync(10);
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1100);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onAbort.mock.calls[0][0]).toBeInstanceOf(CsvAbortError);
    expect(String(onAbort.mock.calls[0][0])).toMatch(/read nothing/);
    await expect(stream.getReader().read().then(() => "read")).rejects.toBeInstanceOf(CsvAbortError);
  });

  it("drops a download that outlives maxMs even if the client keeps reading slowly", async () => {
    vi.useFakeTimers();
    const onEnd = vi.fn();
    const onAbort = vi.fn();
    const never = () => new Promise<CsvBatch | null>(() => undefined); // a batch that never loads
    createCsvStream({ columns: ["n"], first: batchOf(1, 2, "2"), next: never, idleMs: 10_000, maxMs: 5000, onEnd, onAbort });
    await vi.advanceTimersByTimeAsync(5100);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(String(onAbort.mock.calls[0][0])).toMatch(/exceeded 5000 ms/);
  });

  it("a stream that completes cancels its timers (no late abort after a clean end)", async () => {
    vi.useFakeTimers();
    const onAbort = vi.fn();
    const onEnd = vi.fn();
    const text = readAll(
      createCsvStream({ columns: ["n"], first: batchOf(1, 2, null), next: async () => null, idleMs: 1000, maxMs: 2000, onEnd, onAbort }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await text;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onAbort).not.toHaveBeenCalled();
  });
});
