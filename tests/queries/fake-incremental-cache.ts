/**
 * A tiny in-memory stand-in for Next's incremental cache, installed on
 * `globalThis.__incrementalCache` — the same hook `unstable_cache` falls back
 * to when it runs outside a request. It lets tests (and tsx scripts) run the
 * REAL `unstable_cache` code path, including TTL staleness and tag
 * invalidation, and lets them inspect exactly which entries got stored. That
 * is what proves cache-key hygiene: every hostile input must leave `sets`
 * and `entries` unchanged.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

interface Entry {
  body: string;
  revalidate: number | false;
  tags: string[];
  /** Logical write time (a counter, so same-millisecond writes and invalidations order correctly). */
  version: number;
  /** Wall-clock write time on the cache's injectable clock. */
  storedAtMs: number;
}

export interface StoredEntry {
  key: string;
  revalidate: number | false;
  tags: string[];
  body: string;
}

export class FakeIncrementalCache {
  readonly isOnDemandRevalidate = false;
  private store = new Map<string, Entry>();
  private tagVersions = new Map<string, number>();
  private counter = 0;
  /** Milliseconds added to the real clock; `advance()` simulates TTL expiry. */
  private skewMs = 0;
  sets = 0;
  gets = 0;
  hits = 0;

  private now(): number {
    return Date.now() + this.skewMs;
  }

  async generateSimpleCacheKey(input: string): Promise<string> {
    return createHash("sha256").update(input).digest("hex");
  }

  async get(key: string) {
    this.gets += 1;
    const entry = this.store.get(key);
    if (!entry) return null;
    // Same rule as Next's file cache: an entry whose tag was revalidated after it was written is a miss.
    if (entry.tags.some((t) => (this.tagVersions.get(t) ?? 0) > entry.version)) return null;
    const isStale = typeof entry.revalidate === "number" && this.now() > entry.storedAtMs + entry.revalidate * 1000;
    this.hits += 1;
    return {
      isStale,
      lastModified: entry.storedAtMs,
      value: {
        kind: "FETCH",
        data: { headers: {}, body: entry.body, status: 200, url: "" },
        revalidate: entry.revalidate,
      },
    };
  }

  async set(
    key: string,
    data: { data: { body: string }; revalidate: number | false },
    ctx: { tags?: string[] } = {},
  ): Promise<void> {
    this.sets += 1;
    this.store.set(key, {
      body: data.data.body,
      revalidate: data.revalidate,
      tags: ctx.tags ?? [],
      version: ++this.counter,
      storedAtMs: this.now(),
    });
  }

  /** What `revalidateTag(tag)` does to stored entries. */
  revalidateTag(tag: string): void {
    this.tagVersions.set(tag, ++this.counter);
  }

  /** Move the clock forward so entries older than their `revalidate` become stale. */
  advance(ms: number): void {
    this.skewMs += ms;
  }

  clear(): void {
    this.store.clear();
    this.tagVersions.clear();
    this.sets = 0;
    this.gets = 0;
    this.hits = 0;
  }

  get size(): number {
    return this.store.size;
  }

  entries(): StoredEntry[] {
    return [...this.store.entries()].map(([key, e]) => ({ key, revalidate: e.revalidate, tags: e.tags, body: e.body }));
  }

  /**
   * Must run BEFORE `next/cache` is first imported: Next's async-storage
   * modules read `globalThis.AsyncLocalStorage` at load time, which its own
   * server bootstrap normally provides.
   */
  install(): void {
    const g = globalThis as unknown as { AsyncLocalStorage?: unknown; __incrementalCache?: unknown };
    g.AsyncLocalStorage ??= AsyncLocalStorage;
    g.__incrementalCache = this;
  }

  uninstall(): void {
    delete (globalThis as unknown as { __incrementalCache?: unknown }).__incrementalCache;
  }
}
