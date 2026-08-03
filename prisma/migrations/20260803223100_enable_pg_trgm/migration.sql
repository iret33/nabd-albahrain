-- Enable pg_trgm for fast fuzzy/substring search on dataset titles,
-- descriptions, and record text fields (used by later phases' search UI).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
