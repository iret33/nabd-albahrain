-- Trigram GIN indexes for fast fuzzy/substring search over dataset
-- titles and descriptions. Prisma doesn't natively model index "ops"
-- (gin_trgm_ops), so this is authored as raw SQL. pg_trgm itself was
-- already enabled by Phase 1's migration
-- (20260803223100_enable_pg_trgm).

CREATE INDEX IF NOT EXISTS "Dataset_titleClean_trgm_idx"
  ON "Dataset" USING gin ("titleClean" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Dataset_description_trgm_idx"
  ON "Dataset" USING gin ("description" gin_trgm_ops);
