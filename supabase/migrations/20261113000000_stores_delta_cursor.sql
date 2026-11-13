-- ─── Per-branch delta cursor (local sync service) ─────────────────────────────
--
-- The local sync service (sync-service/) applies each branch's intraday
-- "Price" files on top of its nightly PriceFull snapshot. These columns record
-- the newest file applied to the branch, written in the same transaction as
-- the branch's price rows, so a file is never applied twice and never skipped:
--   last_delta_ts   fileTimestamp() of that file ("YYYYMMDDHHMMSS", sortable
--                   as text). A full snapshot also moves it forward to its own
--                   timestamp, since the snapshot already includes every
--                   earlier delta.
--   last_delta_file the file's name, for debugging.

alter table stores add column if not exists last_delta_ts text;
alter table stores add column if not exists last_delta_file text;
